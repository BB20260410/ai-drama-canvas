import { createHash } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { getStoryboard, upsertStoryboardRow } from "./production.js";
import { getProjectIndex, scanAndPersist } from "./service.js";
import { appendEvent, getSidecarPaths, loadProjectConfig, readJson, writeJsonAtomic, writeTextAtomic } from "./sidecar.js";
import { withProjectLock } from "./locks.js";
import { withStory, type StoryModule } from "./story-lazy.js";
import type {
  AdaptationChangeImpact,
  AdaptationPlan,
  AdaptationStore,
  AdaptationUnit,
  AdaptationValidation,
  NarrativeBeat,
  NovelAnalysisReviewItem,
  NovelAnalysisTask,
  NovelFact,
  NovelFactKind,
  SourceSpan,
  StoryboardRow,
  StoryboardRowUpsertInput,
  StoryLibrary,
} from "./types.js";

const loadStoryLibrarySnapshot = (...args: Parameters<StoryModule["loadStoryLibrarySnapshot"]>) =>
  withStory((story) => story.loadStoryLibrarySnapshot(...args));
const loadStoryAnalysisSnapshot = (...args: Parameters<StoryModule["loadStoryAnalysisSnapshot"]>) =>
  withStory((story) => story.loadStoryAnalysisSnapshot(...args));

const DIALOGUE_WARNING_RATE = 4;
const DIALOGUE_HARD_RATE = 6;

function now(): string { return new Date().toISOString(); }
function hash(value: string, length = 16): string { return createHash("sha256").update(value).digest("hex").slice(0, length); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function clean(values: string[] | undefined, limit = 100): string[] { return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit); }
function exists(filePath: string): Promise<boolean> { return access(filePath).then(() => true).catch(() => false); }

function emptyStore(): AdaptationStore {
  return { schemaVersion: 1, revision: 0, sourceLibraryRevision: 0, facts: [], beats: [], plans: [], analysisTasks: [], analysisReviews: [], updatedAt: new Date(0).toISOString() };
}

function assertSpan(value: unknown): asserts value is SourceSpan {
  if (!record(value)
    || typeof value.sourceId !== "string"
    || typeof value.chapterId !== "string"
    || !Number.isInteger(value.chapterRevision)
    || typeof value.chapterSha256 !== "string"
    || !Number.isInteger(value.startOffset)
    || !Number.isInteger(value.endOffset)
    || typeof value.text !== "string"
    || Number(value.startOffset) < 0
    || Number(value.endOffset) <= Number(value.startOffset)) throw new Error("adaptation.json 的来源片段结构损坏。 ");
}

function assertStore(value: unknown): asserts value is AdaptationStore {
  if (!record(value)
    || value.schemaVersion !== 1
    || !Number.isInteger(value.revision)
    || !Number.isInteger(value.sourceLibraryRevision)
    || !Array.isArray(value.facts)
    || !Array.isArray(value.beats)
    || !Array.isArray(value.plans)
    || (value.analysisTasks !== undefined && !Array.isArray(value.analysisTasks))
    || (value.analysisReviews !== undefined && !Array.isArray(value.analysisReviews))
    || typeof value.updatedAt !== "string") throw new Error("adaptation.json 结构损坏，已停止读取和写入。 ");
  for (const fact of value.facts) {
    if (!record(fact) || typeof fact.id !== "string" || typeof fact.statement !== "string" || !Array.isArray(fact.sourceSpans) || !Number.isInteger(fact.revision)) throw new Error("adaptation.json 的事实结构损坏。 ");
    fact.sourceSpans.forEach(assertSpan);
  }
  for (const beat of value.beats) {
    if (!record(beat) || typeof beat.id !== "string" || typeof beat.summary !== "string" || !Array.isArray(beat.factIds) || !Array.isArray(beat.sourceSpans) || !Number.isInteger(beat.revision)) throw new Error("adaptation.json 的节拍结构损坏。 ");
    beat.sourceSpans.forEach(assertSpan);
  }
  for (const plan of value.plans) {
    if (!record(plan) || typeof plan.id !== "string" || !["concise", "split"].includes(String(plan.mode)) || !Array.isArray(plan.units) || !Number.isInteger(plan.revision) || !record(plan.validation)) throw new Error("adaptation.json 的计划结构损坏。 ");
    for (const unit of plan.units) if (!record(unit) || typeof unit.id !== "string" || !Array.isArray(unit.storyboardRows)) throw new Error("adaptation.json 的单元结构损坏。 ");
  }
  for (const task of (value.analysisTasks ?? []) as NovelAnalysisTask[]) if (!record(task) || typeof task.id !== "string" || !Array.isArray(task.chapterRefs) || !Array.isArray(task.reviewItemIds) || !Number.isInteger(task.revision)) throw new Error("adaptation.json 的模型分析任务结构损坏。 ");
  for (const review of (value.analysisReviews ?? []) as NovelAnalysisReviewItem[]) if (!record(review) || typeof review.id !== "string" || !["fact", "beat"].includes(String(review.kind)) || !["pending", "accepted", "rejected"].includes(String(review.status)) || !Array.isArray(review.evidenceIssues) || !Number.isInteger(review.revision)) throw new Error("adaptation.json 的模型提案结构损坏。 ");
}

export async function loadAdaptationStore(projectRoot: string): Promise<AdaptationStore> {
  const value = await readJson<unknown | null>(getSidecarPaths(projectRoot).storyAdaptation, null);
  if (value === null) return emptyStore();
  assertStore(value);
  return { ...value, analysisTasks: value.analysisTasks ?? [], analysisReviews: value.analysisReviews ?? [] };
}

export async function saveAdaptationStore(projectRoot: string, store: AdaptationStore): Promise<void> {
  assertStore(store);
  await writeJsonAtomic(getSidecarPaths(projectRoot).storyAdaptation, store);
}

const loadStore = loadAdaptationStore;
const saveStore = saveAdaptationStore;

async function loadLibrary(projectRoot: string): Promise<StoryLibrary> {
  const library = await loadStoryLibrarySnapshot(projectRoot);
  if (!library.sources.length || !library.chapters.length) throw new Error("没有可分析的真实章节索引，请先导入小说原文。 ");
  return library;
}

export async function getAdaptationWorkspace(projectRoot: string): Promise<AdaptationStore> {
  return loadStore(projectRoot);
}

interface FactDraft { kind: NovelFactKind; statement: string; subject?: string; predicate?: string; object?: string; tags?: string[] }

function factDrafts(statement: string): FactDraft[] {
  const drafts: FactDraft[] = [{ kind: "event", statement }];
  const dialogue = dialogueOf(statement);
  if (dialogue) drafts.push({ kind: "dialogue", statement: dialogue, predicate: "说", tags: ["原文对白"] });
  for (const match of statement.matchAll(/([\u4e00-\u9fff]{2,3}?)(?=说|问|喊|答|看|走|跑|冲|抬|笑|哭|醒|来到|进入|离开|守|拿|戴|穿|回头|举起|伸手)/g)) {
    const name = match[1]?.trim();
    if (name && !/(这时|随后|忽然|只见|他们|众人|两人|低声|高声|却仍|仍然|伸手|回头|黑袍|白衣|衣袍|面具|火把|石门|人影|身影)/.test(name)) drafts.push({ kind: "character", statement: `人物：${name}`, subject: name, predicate: "出现" });
  }
  for (const match of statement.matchAll(/(?:在|来到|进入|走进|逃离|离开)([\u4e00-\u9fff]{2,10}?)(?=[，。！？、]|$)/g)) {
    const location = match[1]?.trim();
    if (location && !/^(胸前|手中|身后|面前|眼前|头顶|脚下|脸上)$/.test(location)) drafts.push({ kind: "location", statement: `场景：${location}`, object: location, predicate: "发生于" });
  }
  for (const token of statement.match(/(?:清晨|早晨|正午|午后|黄昏|夜晚|深夜|翌日|次日|十二年后|数年后|\d+年后)/g) ?? []) drafts.push({ kind: "time", statement: `时间：${token}`, object: token });
  for (const token of statement.match(/(?:暴雨|细雨|大雨|风雪|大雪|浓雾|薄雾|雷雨|狂风)/g) ?? []) drafts.push({ kind: "weather", statement: `天气：${token}`, object: token });
  for (const token of statement.match(/(?:完整黄金面具|黄金面具|面具|长剑|短剑|刀|玉佩|铜鼎|神印|火把|灯笼|权杖)/g) ?? []) drafts.push({ kind: "prop", statement: `道具：${token}`, object: token });
  for (const token of statement.match(/(?:白衣|黑袍|长袍|祭司袍|猎装|铠甲|斗篷|衣裙|服饰)/g) ?? []) drafts.push({ kind: "costume", statement: `服装：${token}`, object: token });
  if (/(心中|心想|暗想|意识到|觉得|害怕|担心|后悔|疑惑)/.test(statement)) drafts.push({ kind: "psychology", statement, predicate: "心理活动" });
  if (/(旁白|画外音)/.test(statement)) drafts.push({ kind: "narration", statement, predicate: "旁白" });
  if (/(光线|月光|火光|阴影|回声|水声|风声|雾气|尘土|空气)/.test(statement)) drafts.push({ kind: "environment", statement, predicate: "环境状态" });
  for (const match of statement.matchAll(/([\u4e00-\u9fff]{2,4})的(父亲|母亲|姐姐|妹妹|兄长|弟弟|师父|徒弟|朋友|敌人)/g)) drafts.push({ kind: "relationship", statement: `${match[1]}的${match[2]}`, subject: match[1], predicate: "关系", object: match[2] });
  if (/(不得|禁止|不能|不可|必须|只能)/.test(statement)) drafts.push({ kind: "rule", statement, predicate: "约束" });
  const unique = new Map<string, FactDraft>();
  for (const draft of drafts) unique.set(`${draft.kind}:${draft.statement}`, draft);
  return [...unique.values()];
}

function dialogueOf(statement: string): string | undefined {
  return statement.match(/[“"]([^”"\n]+?)(?:[”"]|$)/)?.[1]?.trim() || undefined;
}

function sentenceSpans(content: string): Array<{ text: string; start: number; end: number }> {
  const output: Array<{ text: string; start: number; end: number }> = [];
  for (const match of content.matchAll(/[^。！？!?\n]+(?:[。！？!?]+[”’\"]?|(?=\n|$))/g)) {
    const raw = match[0] ?? "";
    const text = raw.trim();
    if (text.length < 2) continue;
    const leading = raw.indexOf(text);
    const start = (match.index ?? 0) + Math.max(0, leading);
    output.push({ text, start, end: start + text.length });
  }
  return output;
}

export async function analyzeNovelChapters(projectRoot: string, input: { expectedRevision: number }): Promise<AdaptationStore> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const analysisSnapshot = await loadStoryAnalysisSnapshot(projectRoot);
    const library = analysisSnapshot.library;
    if (!library.sources.length || !library.chapters.length) throw new Error("没有可分析的真实章节索引，请先导入小说原文。 ");
    const store = await loadStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const existingFacts = new Map(store.facts.map((fact) => [fact.id, fact]));
    const existingBeats = new Map(store.beats.map((beat) => [beat.id, beat]));
    const facts: NovelFact[] = [];
    const beats: NarrativeBeat[] = [];
    let beatOrder = 1;
    for (const frozen of [...analysisSnapshot.chapters].sort((left, right) =>
      left.chapter.sourceId.localeCompare(right.chapter.sourceId) || left.chapter.index - right.chapter.index)) {
      const chapter = frozen.chapter;
      const content = frozen.content.endsWith("\n") ? frozen.content.slice(0, -1) : frozen.content;
      for (const sentence of sentenceSpans(content)) {
        const span: SourceSpan = { sourceId: chapter.sourceId, chapterId: chapter.id, chapterRevision: chapter.revision, chapterSha256: chapter.sha256, startOffset: sentence.start, endOffset: sentence.end, text: sentence.text };
        const sentenceFacts = factDrafts(sentence.text).map((draft) => {
          const factId = `fact-${hash(`${chapter.id}:${sentence.start}:${sentence.end}:${draft.kind}:${draft.statement}`)}`;
          const priorFact = existingFacts.get(factId);
          const fact = priorFact ?? { schemaVersion: 1 as const, id: factId, kind: draft.kind, epistemicStatus: "confirmed" as const, statement: draft.statement, subject: draft.subject, predicate: draft.predicate, object: draft.object, sourceSpans: [span], tags: clean(draft.tags), revision: 1, createdAt: now(), updatedAt: now() };
          facts.push(fact);
          return fact;
        });
        const eventFact = sentenceFacts.find((fact) => fact.kind === "event")!;
        const beatId = `beat-${hash(`${eventFact.id}:${sentence.text}`)}`;
        const priorBeat = existingBeats.get(beatId);
        const dialogue = dialogueOf(sentence.text);
        const intense = /[！!]|冲|杀|逃|惊|怒|爆|坠|撞/.test(sentence.text);
        const psychology = /(心中|心想|暗想|意识到|觉得|害怕|担心|后悔|疑惑)/.test(sentence.text) ? sentence.text : undefined;
        beats.push(priorBeat ?? { schemaVersion: 1, id: beatId, order: beatOrder, title: sentence.text.slice(0, 40), summary: sentence.text, narrativePurpose: intense ? "推动冲突或转折" : dialogue ? "通过对白推进人物关系与信息" : "推进已证实事件", visualAction: psychology && !dialogue ? "用人物反应和可见动作承载心理变化" : sentence.text, emotionalShift: intense ? "情绪升高" : "保持并推进", conflict: intense ? sentence.text : undefined, narration: /(旁白|画外音)/.test(sentence.text) ? sentence.text : undefined, psychology, ambience: /(光线|月光|火光|阴影|回声|水声|风声|雾气|尘土|空气)/.test(sentence.text) ? sentence.text : undefined, mustKeep: [eventFact.statement], estimatedDurationSeconds: Math.max(3, Math.min(18, 4 + (dialogue ? dialogueLength(dialogue) / DIALOGUE_WARNING_RATE : 0))), factIds: sentenceFacts.map((fact) => fact.id), sourceSpans: [span], dialogue, intensity: Math.max(1, Math.min(5, intense ? 4 : 2)), revision: 1, createdAt: now(), updatedAt: now() });
        beatOrder += 1;
      }
    }
    const latest = await loadLibrary(projectRoot);
    if (latest.revision !== library.revision) throw new Error("章节在分析期间发生变化，请重新分析。 ");
    const generatedFactIds = new Set(facts.map((fact) => fact.id));
    const generatedBeatIds = new Set(beats.map((beat) => beat.id));
    store.facts = [...facts, ...store.facts.filter((fact) => !generatedFactIds.has(fact.id))];
    store.beats = [...beats, ...store.beats.filter((beat) => !generatedBeatIds.has(beat.id))].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    store.sourceLibraryRevision = library.revision;
    store.revision += 1;
    store.updatedAt = now();
    await saveStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "codex", type: "adaptation.analyzed", data: { facts: facts.length, beats: beats.length, sourceLibraryRevision: library.revision, revision: store.revision } });
    return store;
  });
}

function normalizeFactInput(input: Omit<NovelFact, "schemaVersion" | "revision" | "createdAt" | "updatedAt">): Omit<NovelFact, "schemaVersion" | "revision" | "createdAt" | "updatedAt"> {
  input.sourceSpans.forEach(assertSpan);
  return { ...input, statement: input.statement.trim().slice(0, 20_000), sourceSpans: input.sourceSpans.slice(0, 100), tags: clean(input.tags) };
}

export async function upsertNovelFact(projectRoot: string, input: Omit<NovelFact, "schemaVersion" | "id" | "revision" | "createdAt" | "updatedAt"> & { id?: string; expectedRevision?: number }): Promise<NovelFact> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadStore(projectRoot);
    const existing = input.id ? store.facts.find((fact) => fact.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`找不到小说事实：${input.id}`);
    if (existing && input.expectedRevision === undefined) throw new Error("更新现有小说事实必须提供 expectedRevision。 ");
    if (existing && input.expectedRevision !== existing.revision) throw new Error(`小说事实修订冲突，当前为 ${existing.revision}。`);
    const { expectedRevision: _expectedRevision, ...factInput } = input;
    const normalized = normalizeFactInput({ ...factInput, id: existing?.id ?? input.id ?? `fact-manual-${hash(`${input.statement}:${now()}`)}` });
    const timestamp = now();
    const fact: NovelFact = { ...normalized, epistemicStatus: normalized.epistemicStatus ?? existing?.epistemicStatus ?? "uncertain", schemaVersion: 1, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
    store.facts = store.facts.map((candidate) => candidate.id === fact.id ? fact : candidate);
    if (!existing) store.facts.push(fact);
    store.revision += 1; store.updatedAt = timestamp;
    await saveStore(projectRoot, store);
    return fact;
  });
}

export async function upsertNarrativeBeat(projectRoot: string, input: Omit<NarrativeBeat, "schemaVersion" | "id" | "revision" | "createdAt" | "updatedAt"> & { id?: string; expectedRevision?: number }): Promise<NarrativeBeat> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadStore(projectRoot);
    const existing = input.id ? store.beats.find((beat) => beat.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`找不到叙事节拍：${input.id}`);
    if (existing && input.expectedRevision === undefined) throw new Error("更新现有叙事节拍必须提供 expectedRevision。 ");
    if (existing && input.expectedRevision !== existing.revision) throw new Error(`叙事节拍修订冲突，当前为 ${existing.revision}。`);
    input.sourceSpans.forEach(assertSpan);
    const timestamp = now();
    const beat: NarrativeBeat = { schemaVersion: 1, id: existing?.id ?? input.id ?? `beat-manual-${hash(`${input.summary}:${timestamp}`)}`, order: Math.max(1, Math.trunc(input.order)), title: input.title.trim().slice(0, 180), summary: input.summary.trim().slice(0, 20_000), narrativePurpose: input.narrativePurpose.trim().slice(0, 2_000), visualAction: input.visualAction.trim().slice(0, 8_000), emotionalShift: input.emotionalShift.trim().slice(0, 2_000), conflict: input.conflict?.trim().slice(0, 4_000) || undefined, turn: input.turn?.trim().slice(0, 4_000) || undefined, outcome: input.outcome?.trim().slice(0, 4_000) || undefined, narration: input.narration?.trim().slice(0, 8_000) || undefined, psychology: input.psychology?.trim().slice(0, 8_000) || undefined, ambience: input.ambience?.trim().slice(0, 4_000) || undefined, mustKeep: clean(input.mustKeep, 100), estimatedDurationSeconds: Math.max(0.5, Math.min(120, input.estimatedDurationSeconds)), factIds: clean(input.factIds, 200), sourceSpans: input.sourceSpans.slice(0, 100), dialogue: input.dialogue?.trim().slice(0, 8_000) || undefined, intensity: Math.max(1, Math.min(5, Math.trunc(input.intensity))), revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp };
    store.beats = store.beats.map((candidate) => candidate.id === beat.id ? beat : candidate);
    if (!existing) store.beats.push(beat);
    store.beats.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    store.revision += 1; store.updatedAt = timestamp;
    await saveStore(projectRoot, store);
    return beat;
  });
}

function adaptationImpact(store: AdaptationStore, input: { factIds?: string[]; beatIds?: string[] }): AdaptationChangeImpact {
  const changedFactIds = clean(input.factIds, 200);
  const changedBeatIds = clean(input.beatIds, 200);
  const factIds = new Set(changedFactIds);
  const affectedBeatIds = clean([
    ...changedBeatIds,
    ...store.beats.filter((beat) => beat.factIds.some((id) => factIds.has(id))).map((beat) => beat.id),
  ], 1_000);
  const beatIds = new Set(affectedBeatIds);
  const plans = store.plans.map((plan) => {
    const units = plan.units.filter((unit) => unit.beatIds.some((id) => beatIds.has(id)) || unit.factIds.some((id) => factIds.has(id)));
    const rows = units.flatMap((unit) => unit.storyboardRows);
    return {
      planId: plan.id,
      status: plan.status,
      unitIds: units.map((unit) => unit.id),
      rowIds: rows.map((row) => row.id),
      itemIds: clean(rows.map((row) => row.itemId), 1_000),
    };
  }).filter((plan) => plan.unitIds.length);
  return {
    changedFactIds,
    changedBeatIds,
    affectedBeatIds,
    affectedPlanIds: plans.map((plan) => plan.planId),
    affectedUnitIds: clean(plans.flatMap((plan) => plan.unitIds), 2_000),
    affectedRowIds: clean(plans.flatMap((plan) => plan.rowIds), 5_000),
    affectedItemIds: clean(plans.flatMap((plan) => plan.itemIds), 2_000),
    plans,
  };
}

export async function analyzeAdaptationChangeImpact(projectRoot: string, input: { factIds?: string[]; beatIds?: string[] }): Promise<AdaptationChangeImpact> {
  const store = await loadStore(projectRoot);
  const factIds = clean(input.factIds, 200);
  const beatIds = clean(input.beatIds, 200);
  if (!factIds.length && !beatIds.length) throw new Error("至少提供一个发生变化的事实或节拍 ID。 ");
  for (const id of factIds) if (!store.facts.some((fact) => fact.id === id)) throw new Error(`找不到小说事实：${id}`);
  for (const id of beatIds) if (!store.beats.some((beat) => beat.id === id)) throw new Error(`找不到叙事节拍：${id}`);
  return adaptationImpact(store, { factIds, beatIds });
}

function plannedRow(planId: string, unitId: string, beat: NarrativeBeat, facts: NovelFact[], order: number, durationSeconds: number, referencePaths: string[], purpose: "establish" | "action"): StoryboardRow {
  const timestamp = now();
  const summary = purpose === "establish" ? `建立场景与人物关系：${beat.summary}` : beat.summary;
  return {
    id: `planned-row-${hash(`${planId}:${unitId}:${order}`)}`,
    itemId: `planned:${unitId}`,
    order,
    durationSeconds,
    shotSize: purpose === "establish" ? "全景" : "中景",
    cameraMovement: purpose === "establish" ? "稳定建立镜头" : "缓慢推进",
    cameraAngle: purpose === "establish" ? "平视" : "轻微低机位",
    lens: purpose === "establish" ? "24mm" : "50mm",
    composition: purpose === "establish" ? "环境主导，人物进入视觉焦点" : "人物主体居中偏三分位",
    staging: purpose === "establish" ? "先环境后人物" : "动作沿既定轴线推进",
    action: summary,
    expression: beat.intensity >= 4 ? "紧张、警觉" : "克制、专注",
    emotion: beat.emotionalShift,
    eyeline: "保持与上一镜目标一致",
    screenDirection: "保持既定运动方向",
    axisSide: "不越轴",
    dialogue: purpose === "action" ? beat.dialogue : undefined,
    narration: purpose === "action" ? beat.narration : undefined,
    ambience: beat.ambience ?? "场景自然底噪",
    soundEffects: [],
    continuityBefore: "承接上一镜动作与视线",
    continuityAfter: "为下一镜保留明确动作落点",
    referenceNames: facts.map((fact) => fact.statement.slice(0, 40)),
    firstFramePrompt: `${summary}，电影写实，竖屏构图，保持角色、服饰、道具与场景连续。`,
    endFramePrompt: `${beat.summary}动作落点，电影写实，保持身份与空间连续。`,
    videoPrompt: `${beat.summary}，动作自然连续，镜头运动克制，不改变硬锁设定。`,
    referencePaths,
    referenceArtifactIds: [],
    upstreamFactRefs: facts.map((fact) => ({ id: fact.id, revision: fact.revision })),
    upstreamBeatRefs: [{ id: beat.id, revision: beat.revision }],
    sourceSpans: beat.sourceSpans,
    adaptationPlanId: planId,
    adaptationUnitId: unitId,
    directorIntent: purpose === "establish" ? "先明确空间与人物位置，再推进核心动作。" : "把叙事动作压缩到清晰、可视的单一变化。",
    emotionalIntent: `强度 ${beat.intensity}/5，保持情绪递进。`,
    continuityNotes: ["承接上一镜动作方向", "硬锁角色和道具不得改变"],
    status: "draft",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildPlan(store: AdaptationStore, library: StoryLibrary, mode: "concise" | "split", episode: number, startUnit: number): AdaptationPlan {
  const timestamp = now();
  const planId = `adaptation-${mode}-${hash(`${store.sourceLibraryRevision}:${episode}:${startUnit}:${store.beats.map((beat) => `${beat.id}@${beat.revision}`).join("|")}`)}`;
  const groups: NarrativeBeat[][] = [];
  if (mode === "concise") {
    const ranked = [...store.beats].sort((a, b) => Number(Boolean(b.dialogue)) - Number(Boolean(a.dialogue)) || b.intensity - a.intensity || a.order - b.order);
    const selected = new Map<string, NarrativeBeat>();
    if (store.beats[0]) selected.set(store.beats[0].id, store.beats[0]);
    if (store.beats.at(-1)) selected.set(store.beats.at(-1)!.id, store.beats.at(-1)!);
    for (const beat of ranked) if (selected.size < 6) selected.set(beat.id, beat);
    groups.push([...selected.values()].sort((a, b) => a.order - b.order));
  } else {
    let current: NarrativeBeat[] = [];
    let duration = 0;
    for (const beat of store.beats) {
      const next = Math.min(15, Math.max(3, beat.estimatedDurationSeconds));
      if (current.length && (duration + next > 15 || current.length >= 6)) { groups.push(current); current = []; duration = 0; }
      current.push(beat); duration += next;
    }
    if (current.length) groups.push(current);
  }
  const chapterPath = new Map(library.chapters.map((chapter) => [chapter.id, chapter.path]));
  const factMap = new Map(store.facts.map((fact) => [fact.id, fact]));
  const units: AdaptationUnit[] = groups.map((beats, index) => {
    const unitNumber = startUnit + index;
    const unitId = `adapt-unit-ep${episode}-u${unitNumber}-${hash(beats.map((beat) => beat.id).join("|"), 8)}`;
    const rows: StoryboardRow[] = [];
    const unitDuration = mode === "concise" ? 15 : Math.min(15, Math.max(3, beats.reduce((sum, beat) => sum + Math.max(3, beat.estimatedDurationSeconds), 0)));
    const weights = beats.map((beat) => Math.max(1, beat.estimatedDurationSeconds));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    beats.forEach((beat, position) => {
      const facts = beat.factIds.map((id) => factMap.get(id)).filter((fact): fact is NovelFact => Boolean(fact));
      const refs = clean(beat.sourceSpans.map((span) => chapterPath.get(span.chapterId) ?? ""));
      const duration = position === beats.length - 1
        ? Number((unitDuration - rows.reduce((sum, row) => sum + row.durationSeconds, 0)).toFixed(3))
        : Number((unitDuration * (weights[position]! / weightTotal)).toFixed(3));
      rows.push(plannedRow(planId, unitId, beat, facts, position + 1, Math.max(0.5, duration), refs, position === 0 ? "establish" : "action"));
    });
    return { id: unitId, episode, unit: unitNumber, title: beats.map((beat) => beat.title).join(" / ").slice(0, 100), durationSeconds: unitDuration, beatIds: beats.map((beat) => beat.id), factIds: clean(beats.flatMap((beat) => beat.factIds), 200), directorIntent: mode === "concise" ? "用最少镜头保留主要因果。" : "按节拍时长连续分组，保持动作、空间与情绪衔接。", emotionalArc: `由强度 ${beats[0]?.intensity ?? 1} 推进至 ${beats.at(-1)?.intensity ?? 1}`, continuityNotes: ["同一单元累计不超过 15 秒", "相邻镜头保持轴线与动作连续"], storyboardRows: rows };
  });
  return { schemaVersion: 1, id: planId, name: mode === "concise" ? "精简改编方案" : "拆分改编方案", mode, status: "draft", sourceLibraryRevision: store.sourceLibraryRevision, units, validation: { hardErrors: [], warnings: [], checkedAt: timestamp }, revision: 1, createdAt: timestamp, updatedAt: timestamp };
}

function rebuildAdaptationUnit(plan: AdaptationPlan, unit: AdaptationUnit, store: AdaptationStore, library: StoryLibrary): AdaptationUnit {
  const beatMap = new Map(store.beats.map((beat) => [beat.id, beat]));
  const factMap = new Map(store.facts.map((fact) => [fact.id, fact]));
  const chapterPath = new Map(library.chapters.map((chapter) => [chapter.id, chapter.path]));
  const beats = unit.beatIds.map((id) => beatMap.get(id));
  if (beats.some((beat) => !beat)) throw new Error(`${unit.id} 引用的节拍已经不存在，必须重新生成完整方案。`);
  const resolved = beats as NarrativeBeat[];
  const durationSeconds = plan.mode === "concise" ? 15 : Math.min(15, Math.max(3, resolved.reduce((sum, beat) => sum + Math.max(3, beat.estimatedDurationSeconds), 0)));
  const weights = resolved.map((beat) => Math.max(1, beat.estimatedDurationSeconds));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const rows: StoryboardRow[] = [];
  resolved.forEach((beat, index) => {
    const facts = beat.factIds.map((id) => factMap.get(id)).filter((fact): fact is NovelFact => Boolean(fact));
    const referencePaths = clean(beat.sourceSpans.map((span) => chapterPath.get(span.chapterId) ?? ""));
    const duration = index === resolved.length - 1
      ? Number((durationSeconds - rows.reduce((sum, row) => sum + row.durationSeconds, 0)).toFixed(3))
      : Number((durationSeconds * (weights[index]! / totalWeight)).toFixed(3));
    rows.push(plannedRow(plan.id, unit.id, beat, facts, index + 1, Math.max(0.5, duration), referencePaths, index === 0 ? "establish" : "action"));
  });
  return {
    ...unit,
    title: resolved.map((beat) => beat.title).join(" / ").slice(0, 100),
    durationSeconds,
    factIds: clean(resolved.flatMap((beat) => beat.factIds), 200),
    emotionalArc: `由强度 ${resolved[0]?.intensity ?? 1} 推进至 ${resolved.at(-1)?.intensity ?? 1}`,
    storyboardRows: rows,
  };
}

export async function regenerateAdaptationScope(projectRoot: string, input: { planId: string; expectedRevision: number; factIds?: string[]; beatIds?: string[] }): Promise<{ workspace: AdaptationStore; plan: AdaptationPlan; impact: AdaptationChangeImpact; regeneratedUnitIds: string[] }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const plan = store.plans.find((candidate) => candidate.id === input.planId);
    if (!plan) throw new Error(`找不到改编计划：${input.planId}`);
    const impact = adaptationImpact(store, { factIds: input.factIds, beatIds: input.beatIds });
    const planImpact = impact.plans.find((candidate) => candidate.planId === plan.id);
    if (!planImpact?.unitIds.length) throw new Error("指定变化不会影响该改编计划，无需重新生成。 ");
    const library = await loadLibrary(projectRoot);
    if (library.revision !== store.sourceLibraryRevision || plan.sourceLibraryRevision !== library.revision) throw new Error("章节已经变化，请先重新分析完整章节。 ");
    const affected = new Set(planImpact.unitIds);
    const units = plan.units.map((unit) => affected.has(unit.id) ? rebuildAdaptationUnit(plan, unit, store, library) : unit);
    const validation = await validateAdaptationPlan(projectRoot, { ...plan, units }, { ...store, plans: store.plans.map((candidate) => candidate.id === plan.id ? { ...candidate, units } : candidate) });
    const timestamp = now();
    const updatedPlan: AdaptationPlan = {
      ...plan,
      status: "selected",
      units,
      validation,
      pendingUnitIds: planImpact.unitIds,
      revision: plan.revision + 1,
      updatedAt: timestamp,
    };
    store.plans = store.plans.map((candidate) => candidate.id === plan.id
      ? updatedPlan
      : candidate.status === "selected" ? { ...candidate, status: "draft", revision: candidate.revision + 1, updatedAt: timestamp } : candidate);
    store.selectedPlanId = plan.id;
    store.revision += 1;
    store.updatedAt = timestamp;
    await saveStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "codex", type: "adaptation.scope-regenerated", data: { planId: plan.id, factIds: impact.changedFactIds, beatIds: impact.changedBeatIds, unitIds: planImpact.unitIds, unaffectedUnitIds: plan.units.filter((unit) => !affected.has(unit.id)).map((unit) => unit.id), revision: store.revision } });
    return { workspace: store, plan: updatedPlan, impact, regeneratedUnitIds: planImpact.unitIds };
  });
}

function dialogueLength(value: string): number { return [...value.replace(/[\s，。！？、；：“”‘’"'…—,.!?;:()（）]/g, "")].length; }

function forbiddenTerms(note: string): string[] {
  const terms: string[] = [];
  for (const match of note.matchAll(/(?:不得|禁止|不能|不可|严禁)(?:改成|变成|使用|出现|为)?([^，。；\n]{2,24})/g)) if (match[1]) terms.push(match[1].trim());
  return clean(terms);
}

function hasAffirmativeForbiddenTerm(value: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutExplicitNegation = value.replace(new RegExp(`(?:不得|禁止|不能|不可|严禁)[^，。；\\n]{0,24}${escaped}`, "g"), "");
  return withoutExplicitNegation.includes(term);
}

export async function validateAdaptationPlan(projectRoot: string, plan: AdaptationPlan, storeInput?: AdaptationStore): Promise<AdaptationValidation> {
  const store = storeInput ?? await loadStore(projectRoot);
  const library = await loadLibrary(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  if (plan.sourceLibraryRevision !== library.revision) hardErrors.push(`计划使用的章节修订 ${plan.sourceLibraryRevision} 已过期，当前为 ${library.revision}`);
  const factMap = new Map(store.facts.map((fact) => [fact.id, fact]));
  const beatMap = new Map(store.beats.map((beat) => [beat.id, beat]));
  const chapterMap = new Map(library.chapters.map((chapter) => [chapter.id, chapter]));
  const unitKeys = new Set<string>();
  for (const unit of plan.units) {
    const unitKey = `${unit.episode}:${unit.unit}`;
    if (unitKeys.has(unitKey)) hardErrors.push(`${unit.id} 与其他单元重复使用 EP${unit.episode} / ${unit.unit}`);
    unitKeys.add(unitKey);
    if (unit.durationSeconds <= 0 || unit.durationSeconds > 15) hardErrors.push(`${unit.id} 时长必须在 0–15 秒`);
    if (!unit.storyboardRows.length || unit.storyboardRows.length > 6) hardErrors.push(`${unit.id} 镜头数必须在 1–6`);
    const rowDuration = unit.storyboardRows.reduce((sum, row) => sum + row.durationSeconds, 0);
    if (rowDuration > 15.001 || Math.abs(rowDuration - unit.durationSeconds) > 0.01) hardErrors.push(`${unit.id} 镜头累计时长 ${rowDuration.toFixed(2)} 与单元时长不一致或超过 15 秒`);
    for (const row of unit.storyboardRows) {
      if (row.durationSeconds <= 0 || row.durationSeconds > 15) hardErrors.push(`${row.id} 镜头时长不合法`);
      if (!row.sourceSpans?.length) hardErrors.push(`${row.id} 缺少真实章节来源证据`);
      for (const span of row.sourceSpans ?? []) {
        const chapter = chapterMap.get(span.chapterId);
        if (!chapter || chapter.revision !== span.chapterRevision || chapter.sha256 !== span.chapterSha256) hardErrors.push(`${row.id} 的章节证据已失效：${span.chapterId}`);
      }
      for (const ref of row.upstreamFactRefs ?? []) if (factMap.get(ref.id)?.revision !== ref.revision) hardErrors.push(`${row.id} 的事实引用已失效：${ref.id}`);
      for (const ref of row.upstreamBeatRefs ?? []) if (beatMap.get(ref.id)?.revision !== ref.revision) hardErrors.push(`${row.id} 的节拍引用已失效：${ref.id}`);
      if (!row.directorIntent?.trim()) warnings.push(`${row.id} 缺少导演意图`);
      if (row.dialogue?.trim()) {
        const rate = dialogueLength(row.dialogue) / row.durationSeconds;
        if (rate > DIALOGUE_HARD_RATE) hardErrors.push(`${row.id} 对白速率 ${rate.toFixed(2)} 字/秒超过硬上限 ${DIALOGUE_HARD_RATE}`);
        else if (rate > DIALOGUE_WARNING_RATE) warnings.push(`${row.id} 对白速率 ${rate.toFixed(2)} 字/秒偏快`);
      }
      const rowText = [row.action, row.dialogue, row.firstFramePrompt, row.endFramePrompt, row.videoPrompt].filter(Boolean).join("\n");
      for (const lock of config.hardLocks) {
        const terms = forbiddenTerms(lock.note);
        if ((lock.name.includes("完整黄金面具") || lock.note.includes("完整黄金面具")) && /(半面具|半张面具|残缺面具)/.test(rowText)) terms.push("半面具");
        for (const term of clean(terms)) if (hasAffirmativeForbiddenTerm(rowText, term)) hardErrors.push(`${row.id} 与硬锁“${lock.name}”冲突：出现禁项“${term}”`);
      }
    }
  }
  return { hardErrors: clean(hardErrors, 1_000), warnings: clean(warnings, 1_000), checkedAt: now() };
}

export async function generateAdaptationPlans(projectRoot: string, input: { expectedRevision: number; episode?: number; startUnit?: number }): Promise<{ workspace: AdaptationStore; plans: AdaptationPlan[] }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    if (!store.beats.length || !store.facts.length) throw new Error("没有可生成计划的事实与节拍，请先分析真实章节。 ");
    const library = await loadLibrary(projectRoot);
    if (library.revision !== store.sourceLibraryRevision) throw new Error("章节已经变化，请重新分析后生成计划。 ");
    const episode = Math.max(1, Math.trunc(input.episode ?? 1));
    const startUnit = Math.max(1, Math.trunc(input.startUnit ?? 1));
    const plans = [buildPlan(store, library, "concise", episode, startUnit), buildPlan(store, library, "split", episode, startUnit)];
    for (const plan of plans) {
      const existing = store.plans.find((candidate) => candidate.id === plan.id);
      plan.revision = (existing?.revision ?? 0) + 1;
      plan.createdAt = existing?.createdAt ?? plan.createdAt;
      plan.validation = await validateAdaptationPlan(projectRoot, plan, store);
    }
    const ids = new Set(plans.map((plan) => plan.id));
    store.plans = [...plans, ...store.plans.filter((plan) => !ids.has(plan.id))];
    store.revision += 1; store.updatedAt = now();
    await saveStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "codex", type: "adaptation.plans-generated", data: { planIds: plans.map((plan) => plan.id), revision: store.revision } });
    return { workspace: store, plans };
  });
}

export async function selectAdaptationPlan(projectRoot: string, planId: string, expectedRevision: number): Promise<AdaptationStore> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    const store = await loadStore(projectRoot);
    if (store.revision !== expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const selected = store.plans.find((plan) => plan.id === planId);
    if (!selected) throw new Error(`找不到改编计划：${planId}`);
    if (selected.status === "materialized") throw new Error("该改编计划已经物化，不能再次选择并重复创建单元。");
    store.plans = store.plans.map((plan) => plan.id === planId ? { ...plan, status: "selected", revision: plan.revision + 1, updatedAt: now() } : plan.status === "selected" ? { ...plan, status: "draft", revision: plan.revision + 1, updatedAt: now() } : plan);
    store.selectedPlanId = planId;
    store.revision += 1; store.updatedAt = now();
    await saveStore(projectRoot, store);
    return store;
  });
}

function safeTitle(value: string): string { return value.normalize("NFKC").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "改编单元"; }

function unitDocument(unit: AdaptationUnit): string {
  const rows = unit.storyboardRows.map((row) => `### 镜头 ${row.order}｜${row.durationSeconds} 秒｜${row.shotSize}\n\n- 运镜：${row.cameraMovement}\n- 动作：${row.action}\n- 对白：${row.dialogue ?? "无"}\n- 导演意图：${row.directorIntent ?? unit.directorIntent}\n- 上游事实：${row.upstreamFactRefs?.map((ref) => `${ref.id}@${ref.revision}`).join("、") || "无"}\n\n首帧提示词：${row.firstFramePrompt}\n\n尾帧提示词：${row.endFramePrompt}\n\n图生视频提示词：${row.videoPrompt}`).join("\n\n");
  return `# EP${String(unit.episode).padStart(2, "0")}_15s_${String(unit.unit).padStart(3, "0")} ${unit.title}\n\n## 导演意图\n\n${unit.directorIntent}\n\n## 情绪弧\n\n${unit.emotionalArc}\n\n## 连续性\n\n${unit.continuityNotes.map((note) => `- ${note}`).join("\n")}\n\n## 正式分镜草案\n\n${rows}\n`;
}

export async function materializeSelectedAdaptationPlan(projectRoot: string, input: { expectedRevision: number; confirmRows?: boolean }): Promise<{ workspace: AdaptationStore; plan: AdaptationPlan; unitPaths: string[]; storyboardRows: StoryboardRow[]; validation: AdaptationValidation }> {
  return withProjectLock(projectRoot, "adaptation", async () => {
    if (input.confirmRows) throw new Error("自动生成的文字分镜必须先人工确认，不能在物化时直接标记 confirmed。");
    const store = await loadStore(projectRoot);
    if (store.revision !== input.expectedRevision) throw new Error(`改编工作区修订冲突，当前为 ${store.revision}。`);
    const plan = store.plans.find((candidate) => candidate.id === store.selectedPlanId);
    if (!plan || plan.status !== "selected") throw new Error("必须先选定一个尚未物化的改编计划。 ");
    const validation = await validateAdaptationPlan(projectRoot, plan, store);
    if (validation.hardErrors.length) throw new Error(`改编计划硬校验未通过：${validation.hardErrors.join("；")}`);
    const initial = await getProjectIndex(projectRoot);
    const currentStoryboard = await getStoryboard(projectRoot);
    const pendingUnitIds = new Set(plan.pendingUnitIds?.length ? plan.pendingUnitIds : plan.units.map((unit) => unit.id));
    const unitPaths: string[] = [];
    const pendingDocuments: Array<{ path: string; unit: AdaptationUnit }> = [];
    let wroteDocument = false;
    for (const unit of plan.units) {
      const existing = initial.items.find((item) => item.type === "unit" && item.episode === unit.episode && item.unit === unit.unit && item.infoPath);
      if (existing?.infoPath) {
        const belongsToPlan = currentStoryboard.rows.some((row) => row.itemId === existing.id && row.adaptationPlanId === plan.id && row.adaptationUnitId === unit.id);
        if (!belongsToPlan) throw new Error(`EP${unit.episode} / 15s ${unit.unit} 已被现有生产单元占用；请更换 startUnit，不能静默附着或覆盖。`);
        unitPaths.push(existing.infoPath); continue;
      }
      const directory = path.join(initial.project.primaryRoot, "AI画布剧本", `EP${String(unit.episode).padStart(2, "0")}`);
      await mkdir(directory, { recursive: true });
      const filePath = path.join(directory, `EP${String(unit.episode).padStart(2, "0")}_15s_${String(unit.unit).padStart(3, "0")}_${safeTitle(unit.title)}.md`);
      if (await exists(filePath)) throw new Error(`目标单元文档已存在但尚未被扫描识别，拒绝覆盖：${filePath}`);
      pendingDocuments.push({ path: filePath, unit });
      unitPaths.push(filePath);
    }
    for (const pending of pendingDocuments) {
      await mkdir(path.dirname(pending.path), { recursive: true });
      await writeTextAtomic(pending.path, unitDocument(pending.unit));
      wroteDocument = true;
    }
    const index = wroteDocument ? await scanAndPersist(projectRoot) : initial;
    const savedRows: StoryboardRow[] = [];
    for (const unit of plan.units) {
      if (!pendingUnitIds.has(unit.id)) continue;
      const item = index.items.find((candidate) => candidate.type === "unit" && candidate.episode === unit.episode && candidate.unit === unit.unit);
      if (!item) throw new Error(`物化后扫描器未识别 EP${unit.episode} / 15s ${unit.unit}。`);
      for (const planned of unit.storyboardRows) {
        const existing = currentStoryboard.rows.find((row) => row.adaptationPlanId === plan.id && row.adaptationUnitId === unit.id && row.order === planned.order);
        const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = planned;
        const rowInput: StoryboardRowUpsertInput = existing
          ? { ...payload, id: existing.id, expectedRevision: existing.revision, itemId: item.id, status: "draft" }
          : { ...payload, itemId: item.id, status: "draft" };
        const saved = await upsertStoryboardRow(projectRoot, rowInput, "codex");
        savedRows.push(saved);
      }
    }
    const materializedAt = now();
    const updatedPlan: AdaptationPlan = {
      ...plan,
      status: "materialized",
      validation,
      units: plan.units.map((unit) => pendingUnitIds.has(unit.id) ? { ...unit, storyboardRows: savedRows.filter((row) => row.adaptationUnitId === unit.id) } : unit),
      pendingUnitIds: undefined,
      revision: plan.revision + 1,
      updatedAt: materializedAt,
      materializedAt,
    };
    store.plans = store.plans.map((candidate) => candidate.id === plan.id ? updatedPlan : candidate);
    store.revision += 1; store.updatedAt = materializedAt;
    await saveStore(projectRoot, store);
    await appendEvent(projectRoot, { actor: "codex", type: "adaptation.materialized", data: { planId: plan.id, units: plan.units.length, storyboardRows: savedRows.length, revision: store.revision } });
    return { workspace: store, plan: updatedPlan, unitPaths, storyboardRows: updatedPlan.units.flatMap((unit) => unit.storyboardRows), validation };
  });
}

function markdownExport(store: AdaptationStore, plan?: AdaptationPlan): string {
  const plans = plan ? [plan] : store.plans;
  const planText = plans.map((entry) => `## ${entry.name}\n\n- ID：${entry.id}\n- 模式：${entry.mode}\n- 状态：${entry.status}\n- 硬错误：${entry.validation.hardErrors.length}\n- 警告：${entry.validation.warnings.length}\n\n${entry.units.map((unit) => `### EP${String(unit.episode).padStart(2, "0")} · 15s ${String(unit.unit).padStart(3, "0")} · ${unit.title}\n\n${unit.storyboardRows.map((row) => `- 镜头 ${row.order}｜${row.durationSeconds}s｜${row.shotSize}｜${row.action}`).join("\n")}`).join("\n\n")}`).join("\n\n");
  return `# 小说自动分镜工作区\n\n- 工作区修订：${store.revision}\n- 章节修订：${store.sourceLibraryRevision}\n- 事实：${store.facts.length}\n- 节拍：${store.beats.length}\n\n${planText}\n`;
}

export async function exportAdaptation(projectRoot: string, input: { format: "json" | "markdown"; outputPath: string; planId?: string }): Promise<{ path: string; format: "json" | "markdown" }> {
  const store = await loadStore(projectRoot);
  const plan = input.planId ? store.plans.find((candidate) => candidate.id === input.planId) : undefined;
  if (input.planId && !plan) throw new Error(`找不到改编计划：${input.planId}`);
  const outputPath = path.resolve(input.outputPath);
  const config = await loadProjectConfig(projectRoot);
  const resolvedParent = await realpath(path.dirname(outputPath)).catch(() => { throw new Error("导出目录不存在；请先选择项目内已经存在的输出目录。 "); });
  const allowedRoots = await Promise.all([config.primaryRoot, ...config.outputRoots].map(async (root) => await realpath(root).catch(() => path.resolve(root))));
  if (!allowedRoots.some((root) => { const relative = path.relative(root, path.join(resolvedParent, path.basename(outputPath))); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); })) throw new Error("导出路径不在项目主根或允许输出根内。 ");
  if (outputPath === path.resolve(getSidecarPaths(projectRoot).storyAdaptation)) throw new Error("导出路径不能覆盖 adaptation.json。 ");
  if (await exists(outputPath)) throw new Error("导出路径已经存在；请使用新的版本路径，不能静默覆盖。 ");
  if (input.format === "json" && path.extname(outputPath).toLowerCase() !== ".json") throw new Error("JSON 导出路径必须使用 .json 扩展名。 ");
  if (input.format === "markdown" && ![".md", ".markdown"].includes(path.extname(outputPath).toLowerCase())) throw new Error("Markdown 导出路径必须使用 .md 或 .markdown 扩展名。 ");
  if (input.format === "json") await writeJsonAtomic(outputPath, plan ? { schemaVersion: 1, workspaceRevision: store.revision, plan } : store);
  else await writeTextAtomic(outputPath, markdownExport(store, plan));
  return { path: outputPath, format: input.format };
}
