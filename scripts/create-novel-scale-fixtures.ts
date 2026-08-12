import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NOVEL_SCALE_FIXTURE_SCHEMA = "ai-canvas/novel-scale-fixture/v1" as const;
export const GOLDEN_ANSWER_SCHEMA = "ai-canvas/novel-scale-golden-answers/v1" as const;
export const DEFAULT_FIXTURE_SEED = "novel-scale-v1-20260731";

export type NovelScale = "S1" | "S3" | "S5";
export type NovelScaleFixtureProfile = "acceptance" | "unit";
export type OracleCategory =
  | "exact"
  | "alias"
  | "state"
  | "future_leakage"
  | "contradiction_candidate_invalidated";

export type OracleCounts = Record<OracleCategory, number>;
export type CanonStatus = "proposed" | "canon" | "conflicted" | "retconned" | "cut";
export type EpistemicStatus = "confirmed" | "inferred" | "uncertain";

export const CANON_STATUSES: readonly CanonStatus[] = ["canon", "proposed", "conflicted", "retconned", "cut"];
export const EPISTEMIC_STATUSES: readonly EpistemicStatus[] = ["confirmed", "inferred", "uncertain"];

export interface NovelScaleFixtureConfig {
  profile: NovelScaleFixtureProfile;
  scale: NovelScale;
  targetCharacters: number;
  chapterCount: number;
  seed: string;
  oracleCounts: OracleCounts;
}

export interface GoldenAnswer {
  id: string;
  category: OracleCategory;
  query: string;
  targetChapter: number;
  expected: {
    canonicalEntityId: string;
    canonicalEntity: string;
    value: string;
    canonStatus: CanonStatus;
    epistemicStatus: EpistemicStatus;
    sourceChapters: number[];
    stateFacts?: StateFactExpectation[];
  };
  forbidden: string[];
  evidence: EvidencePointer[];
}

export interface StateFactExpectation {
  factId: string;
  entityId: string;
  stateKey: string;
  value: string;
  validFromChapter: number;
  validToChapter: number | null;
  supersedes: string | null;
}

export interface EvidencePointer {
  relativePath: "corpus.md";
  offsetEncoding: "utf16-code-unit";
  chapter: number;
  chapterId: string;
  startOffset: number;
  endOffset: number;
  revision: 1;
  sourceSha256: string;
  excerptSha256: string;
  excerpt: string;
}

export interface StatusFixtureRecord {
  id: string;
  canonStatus: CanonStatus;
  epistemicStatus: EpistemicStatus;
  queryGate: "default_query_included" | "candidate_or_conflict_only" | "history_only";
  evidence: EvidencePointer[];
}

export interface GoldenAnswerDocument {
  schemaVersion: typeof GOLDEN_ANSWER_SCHEMA;
  validationProfile: NovelScaleFixtureProfile;
  scale: NovelScale;
  seed: string;
  oracleCounts: OracleCounts;
  statusCoverage: {
    canonStatus: CanonStatus[];
    epistemicStatus: EpistemicStatus[];
  };
  answers: GoldenAnswer[];
  statusFixtures: StatusFixtureRecord[];
}

export interface NovelScaleFixtureManifest {
  schemaVersion: typeof NOVEL_SCALE_FIXTURE_SCHEMA;
  generatorVersion: "1.1.0";
  validationProfile: NovelScaleFixtureProfile;
  scale: NovelScale;
  seed: string;
  targetCharacters: number;
  actualCharacters: number;
  utf16Characters: number;
  utf8Bytes: number;
  chapterCount: number;
  generatorSourceSha256: string;
  corpusFile: "corpus.md";
  corpusSha256: string;
  goldenAnswersFile: "golden-answers.json";
  goldenAnswersSha256: string;
  logicalFingerprint: string;
  oracleCounts: OracleCounts;
  statusCoverage: {
    canonStatus: CanonStatus[];
    epistemicStatus: EpistemicStatus[];
  };
  narrativeDimensions: typeof NARRATIVE_DIMENSIONS;
}

export const NARRATIVE_DIMENSIONS = [
  "entity_alias",
  "location",
  "injury",
  "prop",
  "relationship",
  "knowledge",
  "goal",
  "world_rule",
  "setup_payoff",
  "cross_chapter_state",
] as const;

export const STANDARD_ORACLE_COUNTS: OracleCounts = {
  exact: 100,
  alias: 100,
  state: 100,
  future_leakage: 50,
  contradiction_candidate_invalidated: 50,
};

export const SCALE_PRESETS: Record<NovelScale, Omit<NovelScaleFixtureConfig, "profile" | "seed" | "oracleCounts">> = {
  S1: { scale: "S1", targetCharacters: 1_000_000, chapterCount: 500 },
  S3: { scale: "S3", targetCharacters: 3_000_000, chapterCount: 1_500 },
  S5: { scale: "S5", targetCharacters: 5_000_000, chapterCount: 2_500 },
};

const ENTITY_SURNAMES = ["姜", "姒", "姚", "姬", "妘", "任", "妫", "风", "熊", "柏", "彭", "蜀"] as const;
const ENTITY_NAMES = ["阿航", "嘟嘟", "青禾", "玄川", "岚音", "石魁", "月鸢", "稷羽", "苍梧", "宁烛", "云策", "照野"] as const;
const LOCATIONS = ["雾河渡", "青铜神树", "北岭烽台", "沉星祭坛", "盐井古道", "赤水石窟", "月蚀王庭", "断羽营地", "九曲粮仓", "黑沙驿站", "岷山药谷", "夔门悬桥"] as const;
const INJURIES = ["左肩箭伤", "右腿灼伤", "掌心裂口", "肋骨挫伤", "耳后毒痕", "脚踝扭伤"] as const;
const INJURY_STATES = ["新伤渗血", "止血包扎", "结痂发痒", "恢复活动", "留下旧疤"] as const;
const PROPS = ["玄鸟铜铃", "完整黄金面具", "刻纹骨笛", "乌木药匣", "赤铜短刃", "星砂罗盘", "封泥竹简", "白玉犬牌"] as const;
const PROP_STATES = ["由守门人保管", "转交给同行者", "藏入祭坛暗格", "在追逐中遗失", "经核验重新寻回"] as const;
const RELATIONSHIPS = ["互不信任", "临时结盟", "彼此试探", "共同守密", "公开决裂", "重新和解"] as const;
const KNOWLEDGE = ["祭坛暗门的开启顺序", "王庭使者的真实身份", "铜铃只在月蚀时回应", "北岭粮道已经中断", "面具不能被火焰烧毁", "叛军信号来自水下"] as const;
const GOALS = ["护送证人抵达王庭", "找回失落的铜铃", "查清旧案真凶", "解除药谷封锁", "阻止月蚀献祭", "让难民穿过悬桥"] as const;
const WORLD_RULES = ["说出真名会被神树记录", "月蚀期间铜器不能沾水", "祭司誓言必须由第三人见证", "亡者留下的影子不能越过盐线", "王庭文书只在晨钟后生效", "犬灵不能主动伤害守誓者"] as const;
const SETUPS = ["断裂的第三枚铃舌", "壁画上被刮去的玄鸟", "药匣底层的空槽", "悬桥下逆流的白羽", "竹简末尾多出的指印", "祭坛石缝中的盐粒"] as const;
const CHAPTER_TITLES = ["雾河回声", "神树微光", "北岭来信", "祭坛夜雨", "古道伏痕", "石窟残钟", "王庭密令", "断羽之盟", "粮仓失火", "驿站旧客", "药谷封门", "悬桥追兵"] as const;
const GENERATOR_SOURCE_PATH = fileURLToPath(import.meta.url);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generatorSourceSha256(): string {
  return createHash("sha256").update(readFileSync(GENERATOR_SOURCE_PATH)).digest("hex");
}

export function novelScaleFixtureLogicalFingerprint(value: Omit<NovelScaleFixtureManifest, "logicalFingerprint">): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return input;
  };
  return sha256(JSON.stringify(normalize(value)));
}

function stableIndex(seed: string, namespace: string, index: number, size: number): number {
  if (size <= 0) throw new Error("确定性索引的候选集合不能为空。");
  const digest = createHash("sha256").update(`${seed}\u0000${namespace}\u0000${index}`).digest();
  return digest.readUInt32BE(0) % size;
}

function pick<T>(values: readonly T[], seed: string, namespace: string, index: number): T {
  const value = values[stableIndex(seed, namespace, index, values.length)];
  if (value === undefined) throw new Error(`无法从 ${namespace} 选择确定性值。`);
  return value;
}

function chapterFor(index: number, totalItems: number, chapterCount: number): number {
  return Math.min(chapterCount, 1 + Math.floor(index * chapterCount / Math.max(1, totalItems)));
}

function canonicalEntity(seed: string, index: number): string {
  return `${pick(ENTITY_SURNAMES, seed, "entity-surname", index)}${pick(ENTITY_NAMES, seed, "entity-name", index)}`;
}

function oracleEntity(seed: string, category: OracleCategory, index: number): string {
  const labels: Record<OracleCategory, string> = {
    exact: "精确见证",
    alias: "别名见证",
    state: "状态见证",
    future_leakage: "时点见证",
    contradiction_candidate_invalidated: "裁决见证",
  };
  const offsets: Record<OracleCategory, number> = {
    exact: 1_000,
    alias: 2_000,
    state: 3_000,
    future_leakage: 4_000,
    contradiction_candidate_invalidated: 5_000,
  };
  return `${canonicalEntity(seed, offsets[category] + index)}·${labels[category]}${String(index + 1).padStart(3, "0")}`;
}

function entityAlias(seed: string, index: number): string {
  return `${pick(["小", "老", "赤", "玄", "白", "青"], seed, "alias-prefix", index)}${pick(["犬", "鸢", "舟", "灯", "羽", "石"], seed, "alias-suffix", index)}-${String(index + 1).padStart(3, "0")}`;
}

function addAnchor(anchors: Map<number, string[]>, chapter: number, sentence: string): void {
  const current = anchors.get(chapter) ?? [];
  current.push(sentence);
  anchors.set(chapter, current);
}

function oracleId(category: OracleCategory, index: number): string {
  return `${category}-${String(index + 1).padStart(3, "0")}`;
}

function oracleEntityId(category: OracleCategory, index: number): string {
  return `oracle:${category}:${String(index + 1).padStart(3, "0")}`;
}

interface DraftEvidence {
  chapter: number;
  excerpt: string;
}

type DraftGoldenAnswer = Omit<GoldenAnswer, "evidence"> & { evidence: DraftEvidence[] };
type DraftStatusFixtureRecord = Omit<StatusFixtureRecord, "evidence"> & { evidence: DraftEvidence[] };
type DraftGoldenAnswerDocument = Omit<GoldenAnswerDocument, "answers" | "statusFixtures"> & {
  answers: DraftGoldenAnswer[];
  statusFixtures: DraftStatusFixtureRecord[];
};

const CANON_TRUTH = { canonStatus: "canon", epistemicStatus: "confirmed" } as const;

function buildGoldenAnswers(config: NovelScaleFixtureConfig): { document: DraftGoldenAnswerDocument; anchors: Map<number, string[]> } {
  if (config.chapterCount < 2) throw new Error("小说规模夹具至少需要 2 章，才能构造未来泄漏 Oracle。");
  const answers: DraftGoldenAnswer[] = [];
  const statusFixtures: DraftStatusFixtureRecord[] = [];
  const anchors = new Map<number, string[]>();

  for (let index = 0; index < config.oracleCounts.exact; index += 1) {
    const entityId = oracleEntityId("exact", index);
    const chapter = chapterFor(index, config.oracleCounts.exact, config.chapterCount);
    const entity = oracleEntity(config.seed, "exact", index);
    const location = pick(LOCATIONS, config.seed, "exact-location", index);
    const marker = `精确证据-${String(index + 1).padStart(3, "0")}`;
    const excerpt = `【${marker}】${entity}在${location}亲手封存了第${index + 11}号铜印，此事只有当章有效。[canonStatus=canon;epistemicStatus=confirmed]`;
    addAnchor(anchors, chapter, excerpt);
    answers.push({
      id: oracleId("exact", index),
      category: "exact",
      query: `${marker}由谁在何处完成？`,
      targetChapter: chapter,
      expected: { canonicalEntityId: entityId, canonicalEntity: entity, value: `${entity}|${location}|第${index + 11}号铜印`, ...CANON_TRUTH, sourceChapters: [chapter] },
      forbidden: [],
      evidence: [{ chapter, excerpt }],
    });
  }

  for (let index = 0; index < config.oracleCounts.alias; index += 1) {
    const entityId = oracleEntityId("alias", index);
    const chapter = chapterFor(index, config.oracleCounts.alias, config.chapterCount);
    const entity = oracleEntity(config.seed, "alias", index);
    const alias = entityAlias(config.seed, index);
    const excerpt = `【别名证据-${String(index + 1).padStart(3, "0")}】当地人口中的“${alias}”就是${entity}，并非另一名角色。[canonStatus=canon;epistemicStatus=confirmed]`;
    addAnchor(anchors, chapter, excerpt);
    answers.push({
      id: oracleId("alias", index),
      category: "alias",
      query: `${alias}的正典姓名是什么？`,
      targetChapter: chapter,
      expected: { canonicalEntityId: entityId, canonicalEntity: entity, value: entity, ...CANON_TRUTH, sourceChapters: [chapter] },
      forbidden: ["独立角色"],
      evidence: [{ chapter, excerpt }],
    });
  }

  for (let index = 0; index < config.oracleCounts.state; index += 1) {
    const answerId = oracleId("state", index);
    const entityId = oracleEntityId("state", index);
    const chapter = chapterFor(index, config.oracleCounts.state, config.chapterCount);
    const entity = oracleEntity(config.seed, "state", index);
    const injury = pick(INJURIES, config.seed, "state-injury", index);
    const state = pick(INJURY_STATES, config.seed, "state-value", index);
    const prop = pick(PROPS, config.seed, "state-prop", index);
    const propState = pick(PROP_STATES, config.seed, "state-prop-value", index);
    const value = `${injury}:${state};${prop}:${propState}`;
    const excerpt = `【状态证据-${String(index + 1).padStart(3, "0")}】截至本章，${entity}的${injury}处于“${state}”，${prop}则“${propState}”。[canonStatus=canon;epistemicStatus=confirmed]`;
    addAnchor(anchors, chapter, excerpt);
    answers.push({
      id: answerId,
      category: "state",
      query: `第${chapter}章结束时，${entity}的全部有效伤势和道具状态是什么？`,
      targetChapter: chapter,
      expected: {
        canonicalEntityId: entityId,
        canonicalEntity: entity,
        value,
        ...CANON_TRUTH,
        sourceChapters: [chapter],
        stateFacts: [
          {
            factId: `${answerId}:injury`,
            entityId,
            stateKey: `injury:${injury}`,
            value: state,
            validFromChapter: chapter,
            validToChapter: null,
            supersedes: null,
          },
          {
            factId: `${answerId}:prop`,
            entityId,
            stateKey: `prop:${prop}`,
            value: propState,
            validFromChapter: chapter,
            validToChapter: null,
            supersedes: null,
          },
        ],
      },
      forbidden: [],
      evidence: [{ chapter, excerpt }],
    });
  }

  for (let index = 0; index < config.oracleCounts.future_leakage; index += 1) {
    const entityId = oracleEntityId("future_leakage", index);
    const targetChapter = 1 + stableIndex(config.seed, "future-target", index, config.chapterCount - 1);
    const distance = 1 + stableIndex(config.seed, "future-distance", index, config.chapterCount - targetChapter);
    const futureChapter = targetChapter + distance;
    const entity = oracleEntity(config.seed, "future_leakage", index);
    const currentState = `仍不知道${pick(KNOWLEDGE, config.seed, "future-current", index)}`;
    const futureState = `已经确认${pick(KNOWLEDGE, config.seed, "future-reveal", index + 500)}`;
    const currentExcerpt = `【时点证据-${String(index + 1).padStart(3, "0")}】到第${targetChapter}章为止，${entity}${currentState}。[canonStatus=canon;epistemicStatus=confirmed]`;
    const futureExcerpt = `【未来证据-${String(index + 1).padStart(3, "0")}】直到第${futureChapter}章，${entity}才${futureState}。[canonStatus=canon;epistemicStatus=confirmed]`;
    addAnchor(anchors, targetChapter, currentExcerpt);
    addAnchor(anchors, futureChapter, futureExcerpt);
    answers.push({
      id: oracleId("future_leakage", index),
      category: "future_leakage",
      query: `只依据第${targetChapter}章及以前，${entity}知道什么？`,
      targetChapter,
      expected: { canonicalEntityId: entityId, canonicalEntity: entity, value: currentState, ...CANON_TRUTH, sourceChapters: [targetChapter] },
      forbidden: [futureState, `第${futureChapter}章`],
      evidence: [{ chapter: targetChapter, excerpt: currentExcerpt }, { chapter: futureChapter, excerpt: futureExcerpt }],
    });
  }

  for (let index = 0; index < config.oracleCounts.contradiction_candidate_invalidated; index += 1) {
    const entityId = oracleEntityId("contradiction_candidate_invalidated", index);
    const resolutionStatuses = ["canon", "retconned", "cut"] as const;
    const resolutionStatus = resolutionStatuses[index % resolutionStatuses.length] ?? "canon";
    const proposedChapter = 1 + stableIndex(config.seed, "candidate-proposed", index, config.chapterCount - 1);
    const invalidatedChapter = proposedChapter + 1 + stableIndex(config.seed, "candidate-invalidated", index, config.chapterCount - proposedChapter);
    const entity = oracleEntity(config.seed, "contradiction_candidate_invalidated", index);
    const candidate = `${entity}可以绕过“${pick(WORLD_RULES, config.seed, "candidate-rule", index)}”`;
    const canon = `${entity}仍受该规则约束，先前说法被证据否定`;
    const proposedExcerpt = `【候选事实-${String(index + 1).padStart(3, "0")}】未经确认的传闻声称：${candidate}。[canonStatus=proposed;epistemicStatus=uncertain]`;
    const invalidatedExcerpt = `【失效裁决-${String(index + 1).padStart(3, "0")}】新证据与传闻矛盾：${canon}；该候选从本章起失效。[canonStatus=${resolutionStatus};epistemicStatus=confirmed]`;
    addAnchor(anchors, proposedChapter, proposedExcerpt);
    addAnchor(anchors, invalidatedChapter, invalidatedExcerpt);
    answers.push({
      id: oracleId("contradiction_candidate_invalidated", index),
      category: "contradiction_candidate_invalidated",
      query: `第${invalidatedChapter}章时，关于${entity}绕过规则的候选是否仍有效？`,
      targetChapter: invalidatedChapter,
      expected: { canonicalEntityId: entityId, canonicalEntity: entity, value: canon, canonStatus: resolutionStatus, epistemicStatus: "confirmed", sourceChapters: [proposedChapter, invalidatedChapter] },
      forbidden: [candidate],
      evidence: [{ chapter: proposedChapter, excerpt: proposedExcerpt }, { chapter: invalidatedChapter, excerpt: invalidatedExcerpt }],
    });
  }

  for (let index = 0; index < CANON_STATUSES.length; index += 1) {
    const canonStatus = CANON_STATUSES[index];
    const epistemicStatus = EPISTEMIC_STATUSES[index % EPISTEMIC_STATUSES.length];
    if (!canonStatus || !epistemicStatus) throw new Error("状态夹具双轴值缺失。");
    const chapter = chapterFor(index, CANON_STATUSES.length, config.chapterCount);
    const excerpt = `【状态夹具-${String(index + 1).padStart(2, "0")}】独立生命周期记录：canonStatus=${canonStatus};epistemicStatus=${epistemicStatus}；不得污染普通正典答案。`;
    addAnchor(anchors, chapter, excerpt);
    statusFixtures.push({
      id: `status-fixture-${String(index + 1).padStart(2, "0")}`,
      canonStatus,
      epistemicStatus,
      queryGate: canonStatus === "canon"
        ? "default_query_included"
        : canonStatus === "proposed" || canonStatus === "conflicted"
          ? "candidate_or_conflict_only"
          : "history_only",
      evidence: [{ chapter, excerpt }],
    });
  }

  return {
    document: {
      schemaVersion: GOLDEN_ANSWER_SCHEMA,
      validationProfile: config.profile,
      scale: config.scale,
      seed: config.seed,
      oracleCounts: { ...config.oracleCounts },
      statusCoverage: {
        canonStatus: [...CANON_STATUSES],
        epistemicStatus: [...EPISTEMIC_STATUSES],
      },
      answers,
      statusFixtures,
    },
    anchors,
  };
}

function baseChapterText(config: NovelScaleFixtureConfig, chapter: number): string {
  const entityA = canonicalEntity(config.seed, chapter * 2);
  const entityB = canonicalEntity(config.seed, chapter * 2 + 1);
  const alias = entityAlias(config.seed, chapter + 10_000);
  const phase = Math.min(INJURY_STATES.length - 1, Math.floor((chapter - 1) * INJURY_STATES.length / config.chapterCount));
  const injuryState = INJURY_STATES[phase] ?? INJURY_STATES[0];
  const propState = PROP_STATES[Math.min(PROP_STATES.length - 1, phase)] ?? PROP_STATES[0];
  return [
    `${entityA}（当地别名“${alias}”）与${entityB}抵达${pick(LOCATIONS, config.seed, "chapter-location", chapter)}，这是第${chapter}章的独立行动记录。`,
    `${entityA}的${pick(INJURIES, config.seed, "chapter-injury", chapter)}从上一阶段变化为“${injuryState}”，${pick(PROPS, config.seed, "chapter-prop", chapter)}当前“${propState}”。`,
    `两人的关系处于“${pick(RELATIONSHIPS, config.seed, "chapter-relationship", chapter)}”；${entityB}此时知道${pick(KNOWLEDGE, config.seed, "chapter-knowledge", chapter)}，目标是${pick(GOALS, config.seed, "chapter-goal", chapter)}。`,
    `本地世界规则写明“${pick(WORLD_RULES, config.seed, "chapter-rule", chapter)}”；伏笔“${pick(SETUPS, config.seed, "chapter-setup", chapter)}”在本章被${chapter % 4 === 0 ? "部分兑现" : "再次强调"}。`,
  ].join("\n\n");
}

function fillerSentence(config: NovelScaleFixtureConfig, chapter: number, paragraph: number): string {
  const entity = canonicalEntity(config.seed, chapter * 10_000 + paragraph);
  const location = pick(LOCATIONS, config.seed, "filler-location", chapter * 1_009 + paragraph);
  const prop = pick(PROPS, config.seed, "filler-prop", chapter * 997 + paragraph);
  const relation = pick(RELATIONSHIPS, config.seed, "filler-relation", chapter * 991 + paragraph);
  const cadence = String(stableIndex(config.seed, "filler-cadence", chapter * 10_000 + paragraph, 9_973)).padStart(4, "0");
  return `\n\n叙事片段${chapter}-${paragraph}-${cadence}：${entity}沿${location}核对${prop}的刻痕，同行者以“${relation}”回应；风向、脚印与钟声的组合只属于这一次观察。`;
}

function buildChapter(config: NovelScaleFixtureConfig, chapter: number, targetLength: number, anchors: readonly string[]): string {
  const title = pick(CHAPTER_TITLES, config.seed, "chapter-title", chapter);
  let content = `# 第${String(chapter).padStart(4, "0")}章 ${title}\n\n${baseChapterText(config, chapter)}`;
  if (anchors.length > 0) content += `\n\n${anchors.join("\n\n")}`;
  if (content.length > targetLength) {
    throw new Error(`第 ${chapter} 章的必需证据为 ${content.length} 字，超过分配预算 ${targetLength} 字；请提高字符预算或减少 Oracle。`);
  }
  let paragraph = 1;
  while (content.length < targetLength) {
    const filler = fillerSentence(config, chapter, paragraph);
    const remaining = targetLength - content.length;
    content += filler.slice(0, remaining);
    paragraph += 1;
  }
  return content;
}

function assertConfig(config: NovelScaleFixtureConfig): void {
  if (config.profile !== "acceptance" && config.profile !== "unit") throw new Error("profile 必须是 acceptance 或 unit。");
  if (!Number.isSafeInteger(config.targetCharacters) || config.targetCharacters <= 0) throw new Error("targetCharacters 必须是正安全整数。");
  if (!Number.isSafeInteger(config.chapterCount) || config.chapterCount < 2) throw new Error("chapterCount 必须是至少 2 的安全整数。");
  if (config.targetCharacters < config.chapterCount * 700) throw new Error("字符预算过小；每章至少需要约 700 字以容纳叙事维度与证据。");
  if (config.seed.trim().length === 0) throw new Error("seed 不能为空。");
  for (const [category, count] of Object.entries(config.oracleCounts)) {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`${category} Oracle 数量必须是正安全整数。`);
  }
  if (config.profile === "acceptance") {
    const preset = SCALE_PRESETS[config.scale];
    if (config.targetCharacters !== preset.targetCharacters || config.chapterCount !== preset.chapterCount) {
      throw new Error(`acceptance profile 的 ${config.scale} 必须使用 ${preset.targetCharacters} 字与 ${preset.chapterCount} 章。`);
    }
    for (const category of Object.keys(STANDARD_ORACLE_COUNTS) as OracleCategory[]) {
      if (config.oracleCounts[category] !== STANDARD_ORACLE_COUNTS[category]) {
        throw new Error("acceptance profile 必须使用 100/100/100/50/50 标准 Oracle 数量。");
      }
    }
  }
}

function chapterFixtureId(chapter: number): string {
  return `chapter-${String(chapter).padStart(6, "0")}`;
}

function enrichEvidence(
  draft: DraftEvidence,
  chapters: readonly string[],
  chapterOffsets: readonly number[],
  sourceSha256: string,
): EvidencePointer {
  const chapterText = chapters[draft.chapter - 1];
  const chapterOffset = chapterOffsets[draft.chapter - 1];
  if (chapterText === undefined || chapterOffset === undefined) throw new Error(`证据章节 ${draft.chapter} 不存在。`);
  const localStart = chapterText.indexOf(draft.excerpt);
  if (localStart < 0) throw new Error(`证据未落入第 ${draft.chapter} 章：${draft.excerpt.slice(0, 80)}`);
  if (chapterText.indexOf(draft.excerpt, localStart + 1) >= 0) throw new Error(`证据在第 ${draft.chapter} 章重复，无法建立唯一 offset。`);
  const startOffset = chapterOffset + localStart;
  return {
    relativePath: "corpus.md",
    offsetEncoding: "utf16-code-unit",
    chapter: draft.chapter,
    chapterId: chapterFixtureId(draft.chapter),
    startOffset,
    endOffset: startOffset + draft.excerpt.length,
    revision: 1,
    sourceSha256,
    excerptSha256: sha256(draft.excerpt),
    excerpt: draft.excerpt,
  };
}

export function buildNovelScaleFixture(config: NovelScaleFixtureConfig): {
  corpus: string;
  goldenAnswersJson: string;
  manifest: NovelScaleFixtureManifest;
  manifestJson: string;
} {
  assertConfig(config);
  const { document: draftDocument, anchors } = buildGoldenAnswers(config);
  const separatorsLength = (config.chapterCount - 1) * 2;
  const chapterCharacters = config.targetCharacters - separatorsLength;
  const baseChapterLength = Math.floor(chapterCharacters / config.chapterCount);
  const remainder = chapterCharacters % config.chapterCount;
  const chapters: string[] = [];
  for (let chapter = 1; chapter <= config.chapterCount; chapter += 1) {
    const targetLength = baseChapterLength + (chapter <= remainder ? 1 : 0);
    chapters.push(buildChapter(config, chapter, targetLength, anchors.get(chapter) ?? []));
  }
  const corpus = chapters.join("\n\n");
  if (corpus.length !== config.targetCharacters) {
    throw new Error(`夹具字符数不闭合：预期 ${config.targetCharacters}，实际 ${corpus.length}。`);
  }
  const corpusDigest = sha256(corpus);
  const chapterOffsets: number[] = [];
  let cursor = 0;
  for (const chapter of chapters) {
    chapterOffsets.push(cursor);
    cursor += chapter.length + 2;
  }
  const document: GoldenAnswerDocument = {
    ...draftDocument,
    answers: draftDocument.answers.map((answer) => ({
      ...answer,
      evidence: answer.evidence.map((evidence) => enrichEvidence(evidence, chapters, chapterOffsets, corpusDigest)),
    })),
    statusFixtures: draftDocument.statusFixtures.map((record) => ({
      ...record,
      evidence: record.evidence.map((evidence) => enrichEvidence(evidence, chapters, chapterOffsets, corpusDigest)),
    })),
  };
  const goldenAnswersJson = `${JSON.stringify(document, null, 2)}\n`;
  const manifestBody: Omit<NovelScaleFixtureManifest, "logicalFingerprint"> = {
    schemaVersion: NOVEL_SCALE_FIXTURE_SCHEMA,
    generatorVersion: "1.1.0",
    validationProfile: config.profile,
    scale: config.scale,
    seed: config.seed,
    targetCharacters: config.targetCharacters,
    actualCharacters: corpus.length,
    utf16Characters: corpus.length,
    utf8Bytes: Buffer.byteLength(corpus, "utf8"),
    chapterCount: config.chapterCount,
    generatorSourceSha256: generatorSourceSha256(),
    corpusFile: "corpus.md",
    corpusSha256: corpusDigest,
    goldenAnswersFile: "golden-answers.json",
    goldenAnswersSha256: sha256(goldenAnswersJson),
    oracleCounts: { ...config.oracleCounts },
    statusCoverage: {
      canonStatus: [...CANON_STATUSES],
      epistemicStatus: [...EPISTEMIC_STATUSES],
    },
    narrativeDimensions: [...NARRATIVE_DIMENSIONS],
  };
  const manifest: NovelScaleFixtureManifest = {
    ...manifestBody,
    logicalFingerprint: novelScaleFixtureLogicalFingerprint(manifestBody),
  };
  return { corpus, goldenAnswersJson, manifest, manifestJson: `${JSON.stringify(manifest, null, 2)}\n` };
}

export async function createNovelScaleFixture(
  outputDirectory: string,
  config: NovelScaleFixtureConfig,
): Promise<NovelScaleFixtureManifest> {
  const fixture = buildNovelScaleFixture(config);
  const resolvedOutput = path.resolve(outputDirectory);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  try {
    await mkdir(resolvedOutput, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`输出路径已存在，夹具生成器只允许写入全新目录：${resolvedOutput}`);
    }
    throw error;
  }
  try {
    await Promise.all([
      writeFile(path.join(resolvedOutput, fixture.manifest.corpusFile), fixture.corpus, { encoding: "utf8", flag: "wx", mode: 0o600 }),
      writeFile(path.join(resolvedOutput, fixture.manifest.goldenAnswersFile), fixture.goldenAnswersJson, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    ]);
    // manifest 最后发布；任何中途失败只会留下无 manifest 的新目录，校验器会拒绝，
    // 且工具绝不递归删除或覆盖任何既有目录。
    await writeFile(path.join(resolvedOutput, "manifest.json"), fixture.manifestJson, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new Error(`夹具写入未完成；为避免误删并发加入的文件，保留无完整 manifest 的新目录 ${resolvedOutput}：${error instanceof Error ? error.message : String(error)}`);
  }
  return fixture.manifest;
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} 必须是正安全整数。`);
  return parsed;
}

export function parseNovelScaleFixtureArgs(args: readonly string[]): {
  outputDirectory: string;
  config: NovelScaleFixtureConfig;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      throw new Error("--force 已禁用：夹具生成器只允许写入全新目录，绝不覆盖或删除既有目录。");
    }
    if (!argument?.startsWith("--")) throw new Error(`无法识别的参数：${argument ?? "<empty>"}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值。`);
    values.set(argument, value);
    index += 1;
  }
  const scale = (values.get("--scale") ?? "S1") as NovelScale;
  const preset = SCALE_PRESETS[scale];
  if (!preset) throw new Error("--scale 仅支持 S1、S3、S5。");
  const output = values.get("--output");
  if (!output) throw new Error("必须通过 --output 指定隔离输出目录。");
  return {
    outputDirectory: path.resolve(output),
    config: {
      profile: "acceptance",
      scale,
      seed: values.get("--seed") ?? DEFAULT_FIXTURE_SEED,
      targetCharacters: values.has("--characters") ? parsePositiveInteger(values.get("--characters"), "--characters") : preset.targetCharacters,
      chapterCount: values.has("--chapters") ? parsePositiveInteger(values.get("--chapters"), "--chapters") : preset.chapterCount,
      oracleCounts: { ...STANDARD_ORACLE_COUNTS },
    },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
  const parsed = parseNovelScaleFixtureArgs(process.argv.slice(2));
  const manifest = await createNovelScaleFixture(parsed.outputDirectory, parsed.config);
  process.stdout.write(`${JSON.stringify({ outputDirectory: parsed.outputDirectory, manifest }, null, 2)}\n`);
}
