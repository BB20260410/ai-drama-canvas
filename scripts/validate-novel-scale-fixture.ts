import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  GOLDEN_ANSWER_SCHEMA,
  NOVEL_SCALE_FIXTURE_SCHEMA,
  CANON_STATUSES,
  EPISTEMIC_STATUSES,
  NARRATIVE_DIMENSIONS,
  SCALE_PRESETS,
  STANDARD_ORACLE_COUNTS,
  generatorSourceSha256,
  novelScaleFixtureLogicalFingerprint,
  type CanonStatus,
  type EpistemicStatus,
  type GoldenAnswer,
  type EvidencePointer,
  type StatusFixtureRecord,
  type NovelScaleFixtureManifest,
  type NovelScaleFixtureProfile,
  type OracleCategory,
  type OracleCounts,
  type StateFactExpectation,
} from "./create-novel-scale-fixtures.js";

const CATEGORIES: readonly OracleCategory[] = [
  "exact",
  "alias",
  "state",
  "future_leakage",
  "contradiction_candidate_invalidated",
];

export interface NovelScaleFixtureValidationResult {
  ok: true;
  directory: string;
  validationProfile: NovelScaleFixtureProfile;
  scale: string;
  characters: number;
  chapters: number;
  corpusSha256: string;
  goldenAnswersSha256: string;
  generatorSourceSha256: string;
  utf8Bytes: number;
  oracleCounts: OracleCounts;
  uniqueChapterBodies: number;
  statusCoverage: {
    canonStatus: CanonStatus[];
    epistemicStatus: EpistemicStatus[];
  };
}

export interface NovelScaleFixtureValidationOptions {
  /** CLI/production defaults to acceptance; unit fixtures must opt in explicitly. */
  expectedProfile?: NovelScaleFixtureProfile;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象。`);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateOracleCounts(value: unknown, label: string): OracleCounts {
  assertRecord(value, label);
  const result = {} as OracleCounts;
  for (const category of CATEGORIES) {
    const count = value[category];
    if (!Number.isSafeInteger(count) || (count as number) <= 0) throw new Error(`${label}.${category} 必须是正安全整数。`);
    result[category] = count as number;
  }
  return result;
}

function validateEvidenceShape(value: unknown, label: string, chapterCount: number): EvidencePointer {
  assertRecord(value, label);
  if (value.relativePath !== "corpus.md") throw new Error(`${label}.relativePath 必须是 corpus.md。`);
  if (value.offsetEncoding !== "utf16-code-unit") throw new Error(`${label}.offsetEncoding 必须是 utf16-code-unit。`);
  if (!Number.isSafeInteger(value.chapter) || (value.chapter as number) < 1 || (value.chapter as number) > chapterCount) throw new Error(`${label}.chapter 越界。`);
  const expectedChapterId = `chapter-${String(value.chapter).padStart(6, "0")}`;
  if (value.chapterId !== expectedChapterId) throw new Error(`${label}.chapterId 与章节不一致。`);
  if (!Number.isSafeInteger(value.startOffset) || !Number.isSafeInteger(value.endOffset)
    || (value.startOffset as number) < 0 || (value.endOffset as number) <= (value.startOffset as number)) throw new Error(`${label} UTF-16 offset 无效。`);
  if (value.revision !== 1) throw new Error(`${label}.revision 必须为 1。`);
  if (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw new Error(`${label}.sourceSha256 无效。`);
  if (typeof value.excerptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.excerptSha256)) throw new Error(`${label}.excerptSha256 无效。`);
  if (typeof value.excerpt !== "string" || value.excerpt.length === 0) throw new Error(`${label}.excerpt 为空。`);
  return value as unknown as EvidencePointer;
}

function validateStateFact(
  value: unknown,
  answerId: string,
  entityId: string,
  targetChapter: number,
  seenFactIds: Set<string>,
): StateFactExpectation {
  assertRecord(value, `${answerId}.stateFact`);
  if (typeof value.factId !== "string" || value.factId.length === 0 || seenFactIds.has(value.factId)) {
    throw new Error(`${answerId} stateFact.factId 缺失或重复。`);
  }
  seenFactIds.add(value.factId);
  if (value.entityId !== entityId) throw new Error(`${answerId} stateFact.entityId 与答案实体不一致。`);
  if (typeof value.stateKey !== "string" || value.stateKey.length === 0) throw new Error(`${answerId} stateFact.stateKey 缺失。`);
  if (typeof value.value !== "string" || value.value.length === 0) throw new Error(`${answerId} stateFact.value 缺失。`);
  if (!Number.isSafeInteger(value.validFromChapter) || (value.validFromChapter as number) < 1
    || (value.validFromChapter as number) > targetChapter) throw new Error(`${answerId} stateFact.validFromChapter 无效。`);
  if (value.validToChapter !== null && (!Number.isSafeInteger(value.validToChapter)
    || (value.validToChapter as number) < targetChapter)) throw new Error(`${answerId} stateFact.validToChapter 未覆盖目标章。`);
  if (value.supersedes !== null && (typeof value.supersedes !== "string" || value.supersedes.length === 0)) {
    throw new Error(`${answerId} stateFact.supersedes 无效。`);
  }
  return value as unknown as StateFactExpectation;
}

function validateAnswer(
  value: unknown,
  chapterCount: number,
  seenIds: Set<string>,
  seenEntityIds: Set<string>,
  seenEntityNames: Set<string>,
  seenFactIds: Set<string>,
): GoldenAnswer {
  assertRecord(value, "golden answer");
  if (typeof value.id !== "string" || value.id.length === 0 || seenIds.has(value.id)) throw new Error(`Oracle id 缺失或重复：${String(value.id)}`);
  seenIds.add(value.id);
  if (!CATEGORIES.includes(value.category as OracleCategory)) throw new Error(`Oracle 类别无效：${String(value.category)}`);
  if (typeof value.query !== "string" || value.query.length === 0) throw new Error(`${value.id} 缺少 query。`);
  if (!Number.isSafeInteger(value.targetChapter) || (value.targetChapter as number) < 1 || (value.targetChapter as number) > chapterCount) {
    throw new Error(`${value.id} targetChapter 越界。`);
  }
  assertRecord(value.expected, `${value.id}.expected`);
  const expectedEntityId = `oracle:${String(value.category)}:${String(value.id).slice(String(value.category).length + 1)}`;
  if (value.expected.canonicalEntityId !== expectedEntityId || seenEntityIds.has(expectedEntityId)) {
    throw new Error(`${value.id} canonicalEntityId 缺失、重复或与类别/序号不一致。`);
  }
  seenEntityIds.add(expectedEntityId);
  if (typeof value.expected.canonicalEntity !== "string" || value.expected.canonicalEntity.length === 0
    || seenEntityNames.has(value.expected.canonicalEntity)) throw new Error(`${value.id} canonicalEntity 缺失或重复。`);
  seenEntityNames.add(value.expected.canonicalEntity);
  if (typeof value.expected.value !== "string" || value.expected.value.length === 0) throw new Error(`${value.id} 缺少 expected.value。`);
  if (!CANON_STATUSES.includes(value.expected.canonStatus as CanonStatus)) throw new Error(`${value.id} expected.canonStatus 无效。`);
  if (!EPISTEMIC_STATUSES.includes(value.expected.epistemicStatus as EpistemicStatus)) throw new Error(`${value.id} expected.epistemicStatus 无效。`);
  if (!Array.isArray(value.expected.sourceChapters) || value.expected.sourceChapters.length === 0
    || !value.expected.sourceChapters.every((chapter) => Number.isSafeInteger(chapter) && (chapter as number) >= 1 && (chapter as number) <= chapterCount)) {
    throw new Error(`${value.id} sourceChapters 必须全为范围内安全整数。`);
  }
  const sourceChapters = value.expected.sourceChapters as number[];
  if (sourceChapters.some((chapter, index) => index > 0 && chapter <= sourceChapters[index - 1]!)) {
    throw new Error(`${value.id} sourceChapters 必须严格升序且去重。`);
  }
  if (!sourceChapters.includes(value.targetChapter as number) || sourceChapters.some((chapter) => chapter > (value.targetChapter as number))) {
    throw new Error(`${value.id} sourceChapters 必须包含 targetChapter 且不得引用未来章。`);
  }
  if (!Array.isArray(value.forbidden) || !value.forbidden.every((item) => typeof item === "string")) throw new Error(`${value.id} forbidden 无效。`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) throw new Error(`${value.id} 缺少 evidence。`);
  const evidence = value.evidence.map((entry, index) => validateEvidenceShape(entry, `${value.id}.evidence[${index}]`, chapterCount));
  const evidenceChapters = [...new Set(evidence.map((entry) => entry.chapter))].sort((left, right) => left - right);
  if (!sourceChapters.every((chapter) => evidenceChapters.includes(chapter))) throw new Error(`${value.id} sourceChapters 缺少对应 evidence。`);
  if (value.category === "future_leakage") {
    if ((value.forbidden as unknown[]).length === 0) throw new Error(`${value.id} 未来泄漏 Oracle 必须声明 forbidden。`);
    const futureEvidence = evidence.some((item) => item.chapter > (value.targetChapter as number));
    if (!futureEvidence) throw new Error(`${value.id} 未来泄漏 Oracle 缺少目标章之后的反证。`);
    const visibleEvidenceChapters = evidenceChapters.filter((chapter) => chapter <= (value.targetChapter as number));
    if (JSON.stringify(visibleEvidenceChapters) !== JSON.stringify(sourceChapters)) {
      throw new Error(`${value.id} 未来泄漏 Oracle 的可见 evidence 与 sourceChapters 不一致。`);
    }
  } else if (evidenceChapters.some((chapter) => chapter > (value.targetChapter as number))
    || JSON.stringify(evidenceChapters) !== JSON.stringify(sourceChapters)) {
    throw new Error(`${value.id} evidence/sourceChapters/targetChapter 不一致。`);
  }
  if (value.category !== "contradiction_candidate_invalidated" && value.expected.canonStatus !== "canon") {
    throw new Error(`${value.id} 普通可返回 Oracle 必须是 canon truth。`);
  }
  if (value.category === "contradiction_candidate_invalidated"
    && !["canon", "retconned", "cut"].includes(value.expected.canonStatus as string)) {
    throw new Error(`${value.id} 候选污染裁决只能收束为 canon/retconned/cut。`);
  }
  if (value.expected.epistemicStatus !== "confirmed") throw new Error(`${value.id} 可返回期望必须是 confirmed。`);
  if (value.category === "state") {
    if (!Array.isArray(value.expected.stateFacts) || value.expected.stateFacts.length !== 2) {
      throw new Error(`${value.id} 状态题必须声明恰好两条全部有效 stateFacts。`);
    }
    const facts = value.expected.stateFacts.map((fact) => validateStateFact(
      fact,
      value.id as string,
      expectedEntityId,
      value.targetChapter as number,
      seenFactIds,
    ));
    const factKinds = facts.map((fact) => fact.stateKey.split(":", 1)[0]).sort();
    if (new Set(facts.map((fact) => fact.stateKey)).size !== facts.length
      || JSON.stringify(factKinds) !== JSON.stringify(["injury", "prop"])
      || facts.some((fact) => fact.validFromChapter !== value.targetChapter
        || fact.validToChapter !== null || fact.supersedes !== null)
      || facts.some((fact) => !(value.expected as { value: string }).value.includes(fact.value))) {
      throw new Error(`${value.id} stateFacts 必须恰好覆盖目标章 injury/prop 全量有效状态。`);
    }
  } else if (value.expected.stateFacts !== undefined) {
    throw new Error(`${value.id} 非状态题不得声明 stateFacts。`);
  }
  return value as unknown as GoldenAnswer;
}

function validateStatusFixture(value: unknown, chapterCount: number, seenIds: Set<string>): StatusFixtureRecord {
  assertRecord(value, "status fixture");
  if (typeof value.id !== "string" || value.id.length === 0 || seenIds.has(value.id)) throw new Error(`status fixture id 缺失或重复：${String(value.id)}`);
  seenIds.add(value.id);
  if (!CANON_STATUSES.includes(value.canonStatus as CanonStatus)) throw new Error(`${value.id} canonStatus 无效。`);
  if (!EPISTEMIC_STATUSES.includes(value.epistemicStatus as EpistemicStatus)) throw new Error(`${value.id} epistemicStatus 无效。`);
  if (!["default_query_included", "candidate_or_conflict_only", "history_only"].includes(value.queryGate as string)) throw new Error(`${value.id} queryGate 无效。`);
  const expectedGate = value.canonStatus === "canon"
    ? "default_query_included"
    : value.canonStatus === "proposed" || value.canonStatus === "conflicted"
      ? "candidate_or_conflict_only"
      : "history_only";
  if (value.queryGate !== expectedGate) throw new Error(`${value.id} queryGate 与 canonStatus 映射不一致。`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) throw new Error(`${value.id} 缺少 evidence。`);
  value.evidence.forEach((evidence, index) => validateEvidenceShape(evidence, `${value.id}.evidence[${index}]`, chapterCount));
  return value as unknown as StatusFixtureRecord;
}

function validateManifest(value: unknown): NovelScaleFixtureManifest {
  assertRecord(value, "manifest");
  if (value.schemaVersion !== NOVEL_SCALE_FIXTURE_SCHEMA) throw new Error("manifest schemaVersion 不匹配。");
  if (value.generatorVersion !== "1.1.0") throw new Error("manifest generatorVersion 必须是 1.1.0。");
  if (value.validationProfile !== "acceptance" && value.validationProfile !== "unit") throw new Error("manifest validationProfile 无效。");
  if (value.scale !== "S1" && value.scale !== "S3" && value.scale !== "S5") throw new Error("manifest scale 无效。");
  if (typeof value.seed !== "string" || value.seed.trim().length === 0) throw new Error("manifest seed 不能为空。");
  if (value.corpusFile !== "corpus.md" || value.goldenAnswersFile !== "golden-answers.json") throw new Error("manifest 文件名合同不匹配。");
  if (!Number.isSafeInteger(value.targetCharacters) || !Number.isSafeInteger(value.actualCharacters)
    || !Number.isSafeInteger(value.utf16Characters) || !Number.isSafeInteger(value.utf8Bytes)) throw new Error("manifest 字符/字节数字段无效。");
  if ((value.targetCharacters as number) <= 0 || (value.actualCharacters as number) <= 0
    || (value.utf16Characters as number) <= 0 || (value.utf8Bytes as number) <= 0) throw new Error("manifest 字符/字节数字段必须为正数。");
  if (!Number.isSafeInteger(value.chapterCount) || (value.chapterCount as number) < 2) throw new Error("manifest chapterCount 无效。");
  if (typeof value.corpusSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.corpusSha256)) throw new Error("manifest corpusSha256 无效。");
  if (typeof value.goldenAnswersSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.goldenAnswersSha256)) throw new Error("manifest goldenAnswersSha256 无效。");
  if (typeof value.logicalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.logicalFingerprint)) throw new Error("manifest logicalFingerprint 无效。");
  if (typeof value.generatorSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.generatorSourceSha256)) throw new Error("manifest generatorSourceSha256 无效。");
  const oracleCounts = validateOracleCounts(value.oracleCounts, "manifest.oracleCounts");
  if (JSON.stringify(value.narrativeDimensions) !== JSON.stringify(NARRATIVE_DIMENSIONS)) {
    throw new Error("manifest narrativeDimensions 不完整或顺序不一致。");
  }
  const manifest = value as unknown as NovelScaleFixtureManifest;
  if (manifest.validationProfile === "acceptance") {
    const preset = SCALE_PRESETS[manifest.scale];
    if (manifest.targetCharacters !== preset.targetCharacters || manifest.actualCharacters !== preset.targetCharacters
      || manifest.utf16Characters !== preset.targetCharacters || manifest.chapterCount !== preset.chapterCount) {
      throw new Error(`acceptance profile 的 ${manifest.scale} 规模/章节不匹配。`);
    }
    for (const category of CATEGORIES) {
      if (oracleCounts[category] !== STANDARD_ORACLE_COUNTS[category]) {
        throw new Error(`acceptance profile 的 ${category} Oracle 数量不满足硬门。`);
      }
    }
  }
  if (manifest.generatorSourceSha256 !== generatorSourceSha256()) throw new Error("manifest generatorSourceSha256 与当前生成器源码不一致。");
  const { logicalFingerprint, ...logicalBody } = manifest;
  if (novelScaleFixtureLogicalFingerprint(logicalBody) !== logicalFingerprint) throw new Error("manifest logicalFingerprint 不匹配。");
  return manifest;
}

export async function validateNovelScaleFixture(
  directory: string,
  options: NovelScaleFixtureValidationOptions = {},
): Promise<NovelScaleFixtureValidationResult> {
  const resolved = path.resolve(directory);
  const manifest = validateManifest(parseJson(await readFile(path.join(resolved, "manifest.json"), "utf8"), "manifest.json"));
  const expectedProfile = options.expectedProfile ?? "acceptance";
  if (manifest.validationProfile !== expectedProfile) {
    throw new Error(`校验 profile 不匹配：要求 ${expectedProfile}，实际 ${manifest.validationProfile}。`);
  }
  const corpus = await readFile(path.join(resolved, manifest.corpusFile), "utf8");
  const goldenJson = await readFile(path.join(resolved, manifest.goldenAnswersFile), "utf8");
  const corpusDigest = sha256(corpus);
  const goldenDigest = sha256(goldenJson);
  if (corpus.length !== manifest.targetCharacters || corpus.length !== manifest.actualCharacters || corpus.length !== manifest.utf16Characters) throw new Error(`语料 UTF-16 字符数不匹配：${corpus.length}。`);
  const utf8Bytes = Buffer.byteLength(corpus, "utf8");
  if (utf8Bytes !== manifest.utf8Bytes) throw new Error(`语料 UTF-8 字节数不匹配：${utf8Bytes}。`);
  if (corpusDigest !== manifest.corpusSha256) throw new Error("corpus SHA-256 不匹配。");
  if (goldenDigest !== manifest.goldenAnswersSha256) throw new Error("golden-answer SHA-256 不匹配。");

  const chapterMatches = [...corpus.matchAll(/^# 第(\d{4,})章 .+$/gm)];
  if (chapterMatches.length !== manifest.chapterCount) throw new Error(`章节数不匹配：${chapterMatches.length}。`);
  if (chapterMatches.some((match, index) => Number(match[1]) !== index + 1)) throw new Error("章节编号必须从 1 开始连续且唯一。");
  const bodies = corpus.split(/(?=^# 第\d{4,}章 )/gm).filter(Boolean).map((chapter) => chapter.replace(/^# .+\n\n/, ""));
  const uniqueChapterBodies = new Set(bodies.map((body) => sha256(body))).size;
  if (uniqueChapterBodies !== manifest.chapterCount) throw new Error("检测到整章正文重复，违反非简单重复合同。");

  const goldenValue = parseJson(goldenJson, "golden-answers.json");
  assertRecord(goldenValue, "golden-answers.json");
  if (goldenValue.schemaVersion !== GOLDEN_ANSWER_SCHEMA) throw new Error("golden-answer schemaVersion 不匹配。");
  if (goldenValue.validationProfile !== manifest.validationProfile
    || goldenValue.scale !== manifest.scale || goldenValue.seed !== manifest.seed) throw new Error("golden profile/scale/seed 与 manifest 不一致。");
  const documentCounts = validateOracleCounts(goldenValue.oracleCounts, "golden.oracleCounts");
  if (!Array.isArray(goldenValue.answers)) throw new Error("golden.answers 必须是数组。");
  const seenIds = new Set<string>();
  const seenEntityIds = new Set<string>();
  const seenEntityNames = new Set<string>();
  const seenFactIds = new Set<string>();
  const answers = goldenValue.answers.map((answer) => validateAnswer(
    answer,
    manifest.chapterCount,
    seenIds,
    seenEntityIds,
    seenEntityNames,
    seenFactIds,
  ));
  if (!Array.isArray(goldenValue.statusFixtures)) throw new Error("golden.statusFixtures 必须是数组。");
  const statusFixtures = goldenValue.statusFixtures.map((record) => validateStatusFixture(record, manifest.chapterCount, seenIds));
  if (statusFixtures.length !== CANON_STATUSES.length) throw new Error(`statusFixtures 必须恰好包含 ${CANON_STATUSES.length} 条。`);
  for (const status of CANON_STATUSES) {
    if (statusFixtures.filter((record) => record.canonStatus === status).length !== 1) throw new Error(`statusFixtures 必须恰好一次覆盖 canonStatus=${status}。`);
  }
  const actualCounts = Object.fromEntries(CATEGORIES.map((category) => [category, answers.filter((answer) => answer.category === category).length])) as OracleCounts;
  for (const category of CATEGORIES) {
    if (actualCounts[category] !== manifest.oracleCounts[category] || actualCounts[category] !== documentCounts[category]) {
      throw new Error(`${category} Oracle 数量不匹配。`);
    }
    const actualIds = answers.filter((answer) => answer.category === category).map((answer) => answer.id).sort();
    const expectedIds = Array.from({ length: actualCounts[category] }, (_unused, index) => `${category}-${String(index + 1).padStart(3, "0")}`);
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw new Error(`${category} Oracle ID 必须从 001 连续且唯一。`);
  }

  const chapterRanges = chapterMatches.map((match, index) => ({
    start: match.index,
    end: chapterMatches[index + 1]?.index ?? corpus.length,
  }));
  const occurrenceCount = (haystack: string, needle: string): number => {
    let count = 0;
    let cursor = 0;
    while (true) {
      const found = haystack.indexOf(needle, cursor);
      if (found < 0) return count;
      count += 1;
      cursor = found + needle.length;
    }
  };
  for (const answer of answers) {
    const expectedOccurrences = answer.category === "future_leakage" || answer.category === "contradiction_candidate_invalidated" ? 2 : 1;
    if (occurrenceCount(corpus, answer.expected.canonicalEntity) !== expectedOccurrences) {
      throw new Error(`${answer.id} Oracle 实体未与基础叙事/其他 Oracle 隔离。`);
    }
    if (answer.category === "future_leakage") {
      const targetRange = chapterRanges[answer.targetChapter - 1];
      if (!targetRange || occurrenceCount(corpus.slice(0, targetRange.end), answer.expected.canonicalEntity) !== 1) {
        throw new Error(`${answer.id} 目标章前存在冲突或重复的未来泄漏实体事实。`);
      }
    }
  }
  const verifyEvidence = (ownerId: string, evidence: EvidencePointer): void => {
    const range = chapterRanges[evidence.chapter - 1];
    if (!range || evidence.startOffset < range.start || evidence.endOffset > range.end) throw new Error(`${ownerId} evidence UTF-16 offset 不在声明章节范围内。`);
    if (corpus.slice(evidence.startOffset, evidence.endOffset) !== evidence.excerpt) throw new Error(`${ownerId} evidence UTF-16 offset 无法反查 excerpt。`);
    if (evidence.sourceSha256 !== corpusDigest) throw new Error(`${ownerId} evidence source SHA-256 不匹配。`);
    if (evidence.excerptSha256 !== sha256(evidence.excerpt)) throw new Error(`${ownerId} evidence excerpt SHA-256 不匹配。`);
  };
  for (const record of [...answers, ...statusFixtures]) {
    for (const evidence of record.evidence) verifyEvidence(record.id, evidence);
  }

  const canonStatusCoverage = [...new Set(statusFixtures.map((record) => record.canonStatus))];
  const epistemicStatusCoverage = [...new Set(statusFixtures.map((record) => record.epistemicStatus))];
  for (const status of CANON_STATUSES) {
    if (!canonStatusCoverage.includes(status)) throw new Error(`缺少 canonStatus=${status} 的 Oracle 覆盖。`);
  }
  for (const status of EPISTEMIC_STATUSES) {
    if (!epistemicStatusCoverage.includes(status)) throw new Error(`缺少 epistemicStatus=${status} 的 Oracle 覆盖。`);
  }
  const declaredCoverage = goldenValue.statusCoverage;
  assertRecord(declaredCoverage, "golden.statusCoverage");
  if (JSON.stringify(declaredCoverage.canonStatus) !== JSON.stringify(CANON_STATUSES)
    || JSON.stringify(declaredCoverage.epistemicStatus) !== JSON.stringify(EPISTEMIC_STATUSES)
    || JSON.stringify(manifest.statusCoverage) !== JSON.stringify(declaredCoverage)) {
    throw new Error("manifest/golden 双轴状态覆盖声明不一致。");
  }

  return {
    ok: true,
    directory: resolved,
    validationProfile: manifest.validationProfile,
    scale: manifest.scale,
    characters: corpus.length,
    chapters: manifest.chapterCount,
    corpusSha256: corpusDigest,
    goldenAnswersSha256: goldenDigest,
    generatorSourceSha256: manifest.generatorSourceSha256,
    utf8Bytes,
    oracleCounts: actualCounts,
    uniqueChapterBodies,
    statusCoverage: {
      canonStatus: canonStatusCoverage,
      epistemicStatus: epistemicStatusCoverage,
    },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
  const directory = process.argv[2];
  if (!directory) throw new Error("用法：tsx scripts/validate-novel-scale-fixture.ts <fixture-directory>");
  const result = await validateNovelScaleFixture(directory);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
