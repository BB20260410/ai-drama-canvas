import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioCanonicalAsset } from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { analyzeStudioScriptEntities, getStudioBindingControl } from "../src/core/studio-binding-control.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  type StudioAssetCategory,
} from "../src/core/studio-production.js";

type ExactMatchKind = "id" | "formal-name" | "alias";

interface LabeledAsset {
  id: string;
  category: StudioAssetCategory;
  name: string;
  aliases: string[];
}

interface LabeledSegment {
  text: string;
  category: StudioAssetCategory;
  expectedAssetIds: string[];
  expectedStatus: "matched" | "ambiguous";
  expectedMatchKind: ExactMatchKind;
  /** 跨类别同词共享同一个原文 span；类别标注负责限定 exact 候选。 */
  sourceSpanId?: string;
}

interface LabeledFixture {
  schemaVersion: 1;
  assets: LabeledAsset[];
  segments: LabeledSegment[];
}

interface ExpectedMention extends LabeledSegment {
  startOffsetUtf16: number;
  endOffsetUtf16: number;
}

const CATEGORIES = ["character", "scene", "prop"] as const satisfies readonly StudioAssetCategory[];
const MATCH_KINDS = ["id", "formal-name", "alias"] as const satisfies readonly ExactMatchKind[];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadFixture(): Promise<LabeledFixture> {
  return JSON.parse(await readFile(new URL("./fixtures/p6-entity-retrieval-labeled.json", import.meta.url), "utf8")) as LabeledFixture;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function identityValues(asset: LabeledAsset, kind: ExactMatchKind): string[] {
  if (kind === "id") return [asset.id];
  if (kind === "formal-name") return [asset.name];
  return asset.aliases;
}

function categoryCounts(values: Array<{ category: StudioAssetCategory }>): Record<StudioAssetCategory, number> {
  return Object.fromEntries(CATEGORIES.map((category) => [
    category,
    values.filter((value) => value.category === category).length,
  ])) as Record<StudioAssetCategory, number>;
}

function assertCorpusCoverage(fixture: LabeledFixture): void {
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.assets.length).toBeGreaterThanOrEqual(24);
  expect(fixture.segments.length).toBeGreaterThanOrEqual(70);

  const assetById = new Map(fixture.assets.map((asset) => [asset.id, asset] as const));
  expect(assetById.size).toBe(fixture.assets.length);
  const assetDistribution = categoryCounts(fixture.assets);
  const mentionDistribution = categoryCounts(fixture.segments);
  for (const category of CATEGORIES) {
    expect(assetDistribution[category], `${category} 规范资产不足 8 个`).toBeGreaterThanOrEqual(8);
    expect(mentionDistribution[category], `${category} 标注 mention 不足 20 条`).toBeGreaterThanOrEqual(20);
    for (const matchKind of MATCH_KINDS) {
      const count = fixture.segments.filter((segment) => segment.category === category
        && segment.expectedMatchKind === matchKind).length;
      expect(count, `${category}/${matchKind} 覆盖不足 8 条`).toBeGreaterThanOrEqual(8);
    }
  }
  expect(Math.max(...Object.values(mentionDistribution)) - Math.min(...Object.values(mentionDistribution))).toBeLessThanOrEqual(2);

  const labeledKeys = fixture.segments.map((segment) => `${normalizeIdentity(segment.text)}\u0000${segment.category}`);
  expect(new Set(labeledKeys).size).toBe(labeledKeys.length);
  for (const segment of fixture.segments) {
    expect(segment.expectedAssetIds.length).toBeGreaterThan(0);
    expect(new Set(segment.expectedAssetIds).size).toBe(segment.expectedAssetIds.length);
    if (segment.expectedStatus === "matched") expect(segment.expectedAssetIds).toHaveLength(1);
    else expect(segment.expectedAssetIds.length).toBeGreaterThanOrEqual(2);
    for (const assetId of segment.expectedAssetIds) {
      const asset = assetById.get(assetId);
      expect(asset, `标注引用了不存在的资产 ${assetId}`).toBeDefined();
      if (!asset) continue;
      expect(asset.category).toBe(segment.category);
      expect(identityValues(asset, segment.expectedMatchKind)
        .some((value) => normalizeIdentity(value) === normalizeIdentity(segment.text)),
      `${segment.text}/${segment.category} 不是 ${assetId} 的 ${segment.expectedMatchKind}`).toBe(true);
    }
  }

  for (const asset of fixture.assets) {
    for (const matchKind of MATCH_KINDS) {
      const covered = fixture.segments.some((segment) => segment.category === asset.category
        && segment.expectedMatchKind === matchKind
        && segment.expectedAssetIds.includes(asset.id)
        && identityValues(asset, matchKind).some((value) => normalizeIdentity(value) === normalizeIdentity(segment.text)));
      expect(covered, `${asset.id} 缺少 ${matchKind} 标注`).toBe(true);
    }
  }

  const sameCategoryAmbiguities = fixture.segments.filter((segment) => segment.expectedStatus === "ambiguous");
  expect(sameCategoryAmbiguities.length).toBeGreaterThanOrEqual(4);
  expect(new Set(sameCategoryAmbiguities.map((segment) => `${normalizeIdentity(segment.text)}\u0000${segment.category}`)).size)
    .toBe(sameCategoryAmbiguities.length);
  expect(sameCategoryAmbiguities.every((segment) => segment.expectedMatchKind === "alias"
    && segment.expectedAssetIds.length >= 2)).toBe(true);

  const sharedSourceSpans = new Map<string, LabeledSegment[]>();
  for (const segment of fixture.segments) {
    if (segment.sourceSpanId) {
      sharedSourceSpans.set(segment.sourceSpanId, [...(sharedSourceSpans.get(segment.sourceSpanId) ?? []), segment]);
    }
  }
  expect(sharedSourceSpans.size).toBeGreaterThanOrEqual(3);
  expect(new Set([...sharedSourceSpans.values()].map((segments) => normalizeIdentity(segments[0]!.text))).size)
    .toBe(sharedSourceSpans.size);
  for (const [sourceSpanId, segments] of sharedSourceSpans) {
    expect(new Set(segments.map((segment) => segment.text)).size, `${sourceSpanId} 原文不一致`).toBe(1);
    expect(new Set(segments.map((segment) => segment.category)).size, `${sourceSpanId} 未跨类别`).toBeGreaterThanOrEqual(2);
    expect(segments.every((segment) => segment.expectedStatus === "matched"
      && segment.expectedMatchKind === "alias"
      && segment.expectedAssetIds.length === 1)).toBe(true);
  }

  const unicodeNormalizationCases = fixture.segments.filter((segment) => segment.text.normalize("NFKC") !== segment.text);
  const chineseNumberCases = fixture.segments.filter((segment) => /[一二三四五六七八九十]/u.test(segment.text));
  const asciiNumberCases = fixture.segments.filter((segment) => /[0-9]/u.test(segment.text));
  const englishNumberWordCases = fixture.segments.filter((segment) => /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/iu.test(segment.text));
  expect(unicodeNormalizationCases.length).toBeGreaterThanOrEqual(6);
  expect(chineseNumberCases.length).toBeGreaterThanOrEqual(6);
  expect(asciiNumberCases.length).toBeGreaterThanOrEqual(6);
  expect(englishNumberWordCases.length).toBeGreaterThanOrEqual(3);
}

function buildLabeledSource(segments: LabeledSegment[]): {
  body: string;
  expected: ExpectedMention[];
  sourceSpanCount: number;
} {
  const separator = "，";
  const spans = new Map<string, { text: string; startOffsetUtf16: number; endOffsetUtf16: number }>();
  let body = "";
  segments.forEach((segment, index) => {
    const sourceSpanId = segment.sourceSpanId ?? `mention-${index + 1}`;
    const existing = spans.get(sourceSpanId);
    if (existing) {
      if (existing.text !== segment.text) throw new Error(`共享 sourceSpanId ${sourceSpanId} 的 text 不一致。`);
      return;
    }
    if (body.length > 0) body += separator;
    const startOffsetUtf16 = body.length;
    body += segment.text;
    spans.set(sourceSpanId, { text: segment.text, startOffsetUtf16, endOffsetUtf16: body.length });
  });
  return {
    body,
    expected: segments.map((segment, index) => {
      const span = spans.get(segment.sourceSpanId ?? `mention-${index + 1}`)!;
      return { ...segment, startOffsetUtf16: span.startOffsetUtf16, endOffsetUtf16: span.endOffsetUtf16 };
    }),
    sourceSpanCount: spans.size,
  };
}

async function buildBenchmark(fixture: LabeledFixture) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p6-retrieval-")));
  roots.push(parent);
  const root = (await createManagedProject({ parentRoot: parent, name: "P6 实体检索标注集" })).paths.root;
  for (const asset of fixture.assets) {
    await createStudioCanonicalAsset(root, {
      id: asset.id,
      category: asset.category,
      name: asset.name,
      aliases: asset.aliases,
      expectedRevision: 0,
    });
  }
  const source = buildLabeledSource(fixture.segments);
  const scriptDocument = await createStudioScriptDocument(root, { id: "script-benchmark", title: "P6 标注剧本", expectedRevision: 0 });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: source.body,
    source: "tests/fixtures/p6-entity-retrieval-labeled.json",
    sourceVersion: "v1",
  });
  const promptDocument = await createStudioPromptDocument(root, { id: "prompt-benchmark", title: "P6 标注提示词", expectedRevision: 0 });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "电影写实，所有规范资产等待人工确认。",
    source: "tests/fixtures/p6-entity-retrieval-labeled.json",
    sourceVersion: "v1",
  });
  const unit = await createStudioProductionUnit(root, {
    id: "unit-benchmark",
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "P6 标注检索",
    scriptRevisionId: script.revision.id,
    expectedRevision: 0,
    panels: [{
      id: "panel-benchmark-1",
      title: "标注宫格一",
      visualAction: source.body,
      shotComposition: "标注测试，不生产图片。",
      filmingMethod: "无。",
      startSeconds: 0,
      endSeconds: 8,
      durationSeconds: 8,
      promptRevisionId: prompt.revision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: source.body.length }],
      assets: [],
    }, {
      id: "panel-benchmark-2",
      title: "标注宫格二",
      visualAction: "仅补足严格 15 秒二宫格合同。",
      shotComposition: "空镜。",
      filmingMethod: "无。",
      startSeconds: 8,
      endSeconds: 15,
      durationSeconds: 7,
      promptRevisionId: prompt.revision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: source.body.length }],
      assets: [],
    }],
  });
  return { root, unit, ...source };
}

describe("P6 实体检索标注指标", () => {
  it("平衡语料真实测量 Precision、精确别名准确率、Recall@5 与静默歧义", async () => {
    const fixture = await loadFixture();
    assertCorpusCoverage(fixture);
    const built = await buildBenchmark(fixture);
    const before = await getStudioBindingControl(built.root, { unitId: built.unit.unit.id });
    await analyzeStudioScriptEntities(built.root, {
      unitId: built.unit.unit.id,
      panelId: "panel-benchmark-1",
      expectedRevisionToken: before.revisionToken,
    }, { requestHash: "6".repeat(64), reviewer: "codex" });
    const control = await getStudioBindingControl(built.root, { unitId: built.unit.unit.id });
    const proposals = control.panels[0]!.proposals;
    const key = (value: { entityText: string; entityCategory: StudioAssetCategory }) => `${value.entityText}\u0000${value.entityCategory}`;
    const expectedByKey = new Map(built.expected.map((entry) => [
      key({ entityText: entry.text, entityCategory: entry.category }),
      entry,
    ] as const));
    const proposalByKey = new Map(proposals.map((proposal) => [key(proposal), proposal] as const));
    expect(proposalByKey.size).toBe(proposals.length);

    for (const expected of built.expected) {
      const proposal = proposalByKey.get(key({ entityText: expected.text, entityCategory: expected.category }));
      expect(proposal, `未检出 ${expected.text}/${expected.category}`).toBeDefined();
      if (!proposal) continue;
      expect(proposal.status).toBe(expected.expectedStatus);
      expect(proposal.matchKind).toBe(expected.expectedMatchKind);
      expect(proposal.candidates.map((candidate) => candidate.assetId).sort()).toEqual([...expected.expectedAssetIds].sort());
      expect(proposal.candidates.every((candidate) => candidate.matchKind === expected.expectedMatchKind)).toBe(true);
    }

    const preciseProposals = proposals.filter((proposal) => {
      const expected = expectedByKey.get(key(proposal));
      return Boolean(expected && proposal.candidates.length > 0
        && proposal.candidates.every((candidate) => expected.expectedAssetIds.includes(candidate.assetId)));
    }).length;
    const exactAliasExpected = built.expected.filter((entry) => entry.expectedStatus === "matched"
      && entry.expectedMatchKind === "alias");
    const exactAliasCorrect = exactAliasExpected.filter((entry) => {
      const proposal = proposalByKey.get(key({ entityText: entry.text, entityCategory: entry.category }));
      return proposal?.status === "matched"
        && proposal.matchKind === "alias"
        && proposal.matchedAssetId === entry.expectedAssetIds[0]
        && proposal.candidates.length === 1
        && proposal.candidates[0]?.matchKind === "alias";
    }).length;
    const relevantAtFive = built.expected.reduce((total, entry) => {
      const proposal = proposalByKey.get(key({ entityText: entry.text, entityCategory: entry.category }));
      const topFive = new Set(proposal?.candidates.slice(0, 5).map((candidate) => candidate.assetId) ?? []);
      return total + entry.expectedAssetIds.filter((assetId) => topFive.has(assetId)).length;
    }, 0);
    const totalRelevant = built.expected.reduce((total, entry) => total + entry.expectedAssetIds.length, 0);
    const silentAmbiguitySelections = proposals.filter((proposal) => proposal.status === "ambiguous"
      && (proposal.matchedAssetId !== undefined || proposal.resolvedAssetId !== undefined)).length;
    const modelCandidateCount = proposals.reduce((total, proposal) => total
      + proposal.candidates.filter((candidate) => candidate.matchKind === "model").length, 0);
    const metrics = {
      assets: fixture.assets.length,
      labeledMentions: built.expected.length,
      proposals: proposals.length,
      sourceSpans: built.sourceSpanCount,
      categoryAssets: categoryCounts(fixture.assets),
      categoryMentions: categoryCounts(fixture.segments),
      exactAliasCases: exactAliasExpected.length,
      sameCategoryAmbiguityGroups: built.expected.filter((entry) => entry.expectedStatus === "ambiguous").length,
      crossCategorySharedSpans: new Set(built.expected.flatMap((entry) => entry.sourceSpanId ? [entry.sourceSpanId] : [])).size,
      precision: preciseProposals / proposals.length,
      exactAliasAccuracy: exactAliasCorrect / exactAliasExpected.length,
      recallAtFive: relevantAtFive / totalRelevant,
      silentAmbiguitySelections,
      modelCandidateCount,
    };
    console.info("P6_RETRIEVAL_BENCHMARK", JSON.stringify(metrics));

    expect(proposals).toHaveLength(built.expected.length);
    expect(metrics.precision).toBe(1);
    expect(metrics.exactAliasAccuracy).toBe(1);
    expect(metrics.recallAtFive).toBeGreaterThanOrEqual(0.95);
    expect(metrics.silentAmbiguitySelections).toBe(0);
    expect(metrics.modelCandidateCount).toBe(0);
  });
});
