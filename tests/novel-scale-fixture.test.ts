import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNovelScaleFixture,
  createNovelScaleFixture,
  DEFAULT_FIXTURE_SEED,
  generatorSourceSha256,
  novelScaleFixtureLogicalFingerprint,
  parseNovelScaleFixtureArgs,
  SCALE_PRESETS,
  STANDARD_ORACLE_COUNTS,
  type NovelScaleFixtureConfig,
} from "../scripts/create-novel-scale-fixtures.js";
import { validateNovelScaleFixture } from "../scripts/validate-novel-scale-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function smallConfig(seed = "unit-test-fixed-seed"): NovelScaleFixtureConfig {
  return {
    profile: "unit",
    scale: "S1",
    seed,
    targetCharacters: 24_000,
    chapterCount: 12,
    oracleCounts: {
      exact: 4,
      alias: 4,
      state: 4,
      future_leakage: 2,
      contradiction_candidate_invalidated: 2,
    },
  };
}

async function tempDirectory(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-novel-scale-fixture-"));
  roots.push(parent);
  return path.join(parent, "fixture");
}

function validateUnitFixture(directory: string): ReturnType<typeof validateNovelScaleFixture> {
  return validateNovelScaleFixture(directory, { expectedProfile: "unit" });
}

describe("确定性中文小说规模夹具", () => {
  it("小型矩阵 manifest 冻结三套配置、摘要和双轴状态，不提交 9M 正文", async () => {
    const matrix = JSON.parse(await readFile(path.resolve("tests/fixtures/novel-scale/manifest.json"), "utf8")) as {
      generatorVersion: string;
      validationProfile: string;
      seed: string;
      largeCorpusCommitted: boolean;
      generatorSourceSha256: string;
      oracleCounts: typeof STANDARD_ORACLE_COUNTS;
      statusCoverage: { canonStatus: string[]; epistemicStatus: string[] };
      scales: Record<"S1" | "S3" | "S5", { targetCharacters: number; utf16Characters: number; utf8Bytes: number; chapterCount: number; corpusSha256: string; goldenAnswersSha256: string; logicalFingerprint: string; sameSeedRunsVerified: number }>;
    };
    expect(matrix.seed).toBe(DEFAULT_FIXTURE_SEED);
    expect(matrix.generatorVersion).toBe("1.1.0");
    expect(matrix.validationProfile).toBe("acceptance");
    expect(matrix.largeCorpusCommitted).toBe(false);
    expect(matrix.generatorSourceSha256).toBe(generatorSourceSha256());
    expect(matrix.oracleCounts).toEqual(STANDARD_ORACLE_COUNTS);
    expect(matrix.statusCoverage).toEqual({
      canonStatus: ["canon", "proposed", "conflicted", "retconned", "cut"],
      epistemicStatus: ["confirmed", "inferred", "uncertain"],
    });
    for (const scale of ["S1", "S3", "S5"] as const) {
      expect(matrix.scales[scale]).toMatchObject({
        targetCharacters: SCALE_PRESETS[scale].targetCharacters,
        utf16Characters: SCALE_PRESETS[scale].targetCharacters,
        utf8Bytes: expect.any(Number),
        chapterCount: SCALE_PRESETS[scale].chapterCount,
        corpusSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        goldenAnswersSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        logicalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        sameSeedRunsVerified: 2,
      });
    }
  });

  it("同一 seed、预算与章数生成完全相同的语料、金标准和 SHA", () => {
    const first = buildNovelScaleFixture(smallConfig());
    const second = buildNovelScaleFixture(smallConfig());
    expect(second.corpus).toBe(first.corpus);
    expect(second.goldenAnswersJson).toBe(first.goldenAnswersJson);
    expect(second.manifestJson).toBe(first.manifestJson);
    expect(first.manifest.actualCharacters).toBe(24_000);
    expect(first.manifest.validationProfile).toBe("unit");
    expect(first.manifest.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.goldenAnswersSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.logicalFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest.generatorSourceSha256).toBe(generatorSourceSha256());
    expect(first.manifest.utf16Characters).toBe(24_000);
    expect(first.manifest.utf8Bytes).toBeGreaterThan(first.manifest.utf16Characters);

    const changed = buildNovelScaleFixture(smallConfig("another-seed"));
    expect(changed.manifest.corpusSha256).not.toBe(first.manifest.corpusSha256);
    expect(changed.manifest.goldenAnswersSha256).not.toBe(first.manifest.goldenAnswersSha256);
  });

  it("严格闭合字符预算、章节预算，并生成五类结构化 Oracle", async () => {
    const root = await tempDirectory();
    await createNovelScaleFixture(root, smallConfig());
    const validation = await validateUnitFixture(root);
    expect(validation).toMatchObject({
      ok: true,
      characters: 24_000,
      chapters: 12,
      uniqueChapterBodies: 12,
      oracleCounts: {
        exact: 4,
        alias: 4,
        state: 4,
        future_leakage: 2,
        contradiction_candidate_invalidated: 2,
      },
      statusCoverage: {
        canonStatus: expect.arrayContaining(["canon", "proposed", "conflicted", "retconned", "cut"]),
        epistemicStatus: expect.arrayContaining(["confirmed", "inferred", "uncertain"]),
      },
    });
    const golden = JSON.parse(await readFile(path.join(root, "golden-answers.json"), "utf8")) as {
      answers: Array<{ category: string; targetChapter: number; forbidden: string[]; expected: { canonicalEntityId: string; canonicalEntity: string; canonStatus: string; epistemicStatus: string; stateFacts?: Array<{ factId: string; entityId: string; stateKey: string; value: string; validFromChapter: number; validToChapter: number | null; supersedes: string | null }> }; evidence: Array<{ chapter: number; relativePath: string; offsetEncoding: string; chapterId: string; startOffset: number; endOffset: number; revision: number; sourceSha256: string; excerptSha256: string }> }>;
      statusFixtures: Array<{ canonStatus: string; epistemicStatus: string; queryGate: string }>;
    };
    const corpus = await readFile(path.join(root, "corpus.md"), "utf8");
    expect(golden.answers).toHaveLength(16);
    expect(golden.answers.filter((answer) => answer.category !== "contradiction_candidate_invalidated").every((answer) => answer.expected.canonStatus === "canon" && answer.expected.epistemicStatus === "confirmed")).toBe(true);
    expect(new Set(golden.statusFixtures.map((record) => record.canonStatus))).toEqual(new Set(["canon", "proposed", "conflicted", "retconned", "cut"]));
    expect(golden.statusFixtures).toHaveLength(5);
    expect(golden.statusFixtures.every((record) => record.queryGate === (record.canonStatus === "canon" ? "default_query_included" : ["proposed", "conflicted"].includes(record.canonStatus) ? "candidate_or_conflict_only" : "history_only"))).toBe(true);
    expect(new Set(golden.statusFixtures.map((record) => record.epistemicStatus))).toEqual(new Set(["confirmed", "inferred", "uncertain"]));
    expect(golden.answers.every((answer) => answer.evidence.every((evidence) => evidence.relativePath === "corpus.md" && evidence.offsetEncoding === "utf16-code-unit" && evidence.chapterId.startsWith("chapter-") && evidence.endOffset > evidence.startOffset && evidence.revision === 1 && /^[a-f0-9]{64}$/.test(evidence.sourceSha256) && /^[a-f0-9]{64}$/.test(evidence.excerptSha256)))).toBe(true);
    expect(new Set(golden.answers.map((answer) => answer.expected.canonicalEntityId)).size).toBe(golden.answers.length);
    expect(new Set(golden.answers.map((answer) => answer.expected.canonicalEntity)).size).toBe(golden.answers.length);
    const stateAnswers = golden.answers.filter((answer) => answer.category === "state");
    expect(stateAnswers.every((answer) => answer.expected.stateFacts?.length === 2
      && new Set(answer.expected.stateFacts.map((fact) => fact.stateKey)).size === 2
      && answer.expected.stateFacts.every((fact) => fact.entityId === answer.expected.canonicalEntityId
        && fact.validFromChapter <= answer.targetChapter && fact.validToChapter === null && fact.supersedes === null))).toBe(true);
    const count = (text: string, needle: string): number => text.split(needle).length - 1;
    expect(golden.answers.filter((answer) => answer.category === "future_leakage").every((answer) => {
      const targetEnd = [...corpus.matchAll(/^# 第\d{4,}章 .+$/gm)][answer.targetChapter]?.index ?? corpus.length;
      return count(corpus.slice(0, targetEnd), answer.expected.canonicalEntity) === 1
        && count(corpus, answer.expected.canonicalEntity) === 2;
    })).toBe(true);
    expect(golden.answers.filter((answer) => answer.category === "future_leakage"))
      .toSatisfy((answers: typeof golden.answers) => answers.every((answer) => answer.forbidden.length > 0 && answer.evidence.some((evidence) => evidence.chapter > answer.targetChapter)));
  });

  it("校验器能发现正文被改写导致的 SHA 漂移", async () => {
    const root = await tempDirectory();
    await createNovelScaleFixture(root, smallConfig());
    const corpusPath = path.join(root, "corpus.md");
    const corpus = await readFile(corpusPath, "utf8");
    await writeFile(corpusPath, `${corpus.slice(0, -1)}改`, "utf8");
    await expect(validateUnitFixture(root)).rejects.toThrow("corpus SHA-256 不匹配");
  });

  it("校验器拒绝被篡改的 UTF-16 offset 与 source SHA", async () => {
    const rewriteGolden = async (root: string, mutate: (golden: { answers: Array<{ evidence: Array<Record<string, unknown>> }>; statusFixtures: Array<Record<string, unknown>> }) => void): Promise<void> => {
      const goldenPath = path.join(root, "golden-answers.json");
      const manifestPath = path.join(root, "manifest.json");
      const golden = JSON.parse(await readFile(goldenPath, "utf8")) as { answers: Array<{ evidence: Array<Record<string, unknown>> }>; statusFixtures: Array<Record<string, unknown>> };
      mutate(golden);
      const goldenJson = `${JSON.stringify(golden, null, 2)}\n`;
      await writeFile(goldenPath, goldenJson, "utf8");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & { logicalFingerprint: string; goldenAnswersSha256: string };
      manifest.goldenAnswersSha256 = createHash("sha256").update(goldenJson, "utf8").digest("hex");
      const { logicalFingerprint: _oldFingerprint, ...logicalBody } = manifest;
      manifest.logicalFingerprint = novelScaleFixtureLogicalFingerprint(logicalBody as Parameters<typeof novelScaleFixtureLogicalFingerprint>[0]);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    };

    const offsetRoot = await tempDirectory();
    await createNovelScaleFixture(offsetRoot, smallConfig());
    await rewriteGolden(offsetRoot, (golden) => {
      const evidence = golden.answers[0]?.evidence[0];
      if (!evidence || typeof evidence.startOffset !== "number") throw new Error("测试证据缺失");
      evidence.startOffset += 1;
    });
    await expect(validateUnitFixture(offsetRoot)).rejects.toThrow("UTF-16 offset 无法反查 excerpt");

    const sourceRoot = await tempDirectory();
    await createNovelScaleFixture(sourceRoot, smallConfig());
    await rewriteGolden(sourceRoot, (golden) => {
      const evidence = golden.answers[0]?.evidence[0];
      if (!evidence) throw new Error("测试证据缺失");
      evidence.sourceSha256 = "a".repeat(64);
    });
    await expect(validateUnitFixture(sourceRoot)).rejects.toThrow("source SHA-256 不匹配");

    const gateRoot = await tempDirectory();
    await createNovelScaleFixture(gateRoot, smallConfig());
    await rewriteGolden(gateRoot, (golden) => {
      const proposed = golden.statusFixtures.find((record) => record.canonStatus === "proposed");
      if (!proposed) throw new Error("测试 proposed 状态夹具缺失");
      proposed.queryGate = "default_query_included";
    });
    await expect(validateUnitFixture(gateRoot)).rejects.toThrow("queryGate 与 canonStatus 映射不一致");
  });

  it("校验器拒绝零 Oracle、越界来源章、错目标章与缺失叙事维度", async () => {
    const rewriteFixture = async (
      root: string,
      mutate: (golden: Record<string, unknown>, manifest: Record<string, unknown>) => void,
    ): Promise<void> => {
      const goldenPath = path.join(root, "golden-answers.json");
      const manifestPath = path.join(root, "manifest.json");
      const golden = JSON.parse(await readFile(goldenPath, "utf8")) as Record<string, unknown>;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & { logicalFingerprint: string };
      mutate(golden, manifest);
      const goldenJson = `${JSON.stringify(golden, null, 2)}\n`;
      await writeFile(goldenPath, goldenJson, "utf8");
      manifest.goldenAnswersSha256 = createHash("sha256").update(goldenJson, "utf8").digest("hex");
      const { logicalFingerprint: _oldFingerprint, ...logicalBody } = manifest;
      manifest.logicalFingerprint = novelScaleFixtureLogicalFingerprint(logicalBody as Parameters<typeof novelScaleFixtureLogicalFingerprint>[0]);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    };

    const zeros = { exact: 0, alias: 0, state: 0, future_leakage: 0, contradiction_candidate_invalidated: 0 };
    const zeroRoot = await tempDirectory();
    await createNovelScaleFixture(zeroRoot, smallConfig());
    await rewriteFixture(zeroRoot, (golden, manifest) => {
      golden.answers = [];
      golden.oracleCounts = zeros;
      manifest.oracleCounts = zeros;
    });
    await expect(validateUnitFixture(zeroRoot)).rejects.toThrow("正安全整数");

    const sourceRoot = await tempDirectory();
    await createNovelScaleFixture(sourceRoot, smallConfig());
    await rewriteFixture(sourceRoot, (golden) => {
      const answers = golden.answers as Array<{ expected: { sourceChapters: unknown[] } }>;
      answers[0]!.expected.sourceChapters = [999_999, "not-a-chapter"];
    });
    await expect(validateUnitFixture(sourceRoot)).rejects.toThrow("sourceChapters 必须全为范围内安全整数");

    const targetRoot = await tempDirectory();
    await createNovelScaleFixture(targetRoot, smallConfig());
    await rewriteFixture(targetRoot, (golden) => {
      const answers = golden.answers as Array<{ targetChapter: number }>;
      answers[0]!.targetChapter = Math.min(12, answers[0]!.targetChapter + 1);
    });
    await expect(validateUnitFixture(targetRoot)).rejects.toThrow(/sourceChapters.*targetChapter|evidence\/sourceChapters\/targetChapter/u);

    const dimensionsRoot = await tempDirectory();
    await createNovelScaleFixture(dimensionsRoot, smallConfig());
    await rewriteFixture(dimensionsRoot, (_golden, manifest) => {
      (manifest.narrativeDimensions as unknown[]).pop();
    });
    await expect(validateUnitFixture(dimensionsRoot)).rejects.toThrow("narrativeDimensions");
  });

  it("unit/acceptance profile 明确分离，生产校验默认 acceptance，CLI 禁用 force", async () => {
    expect(() => buildNovelScaleFixture({ ...smallConfig(), profile: "acceptance" })).toThrow("acceptance profile");
    const unitRoot = await tempDirectory();
    await createNovelScaleFixture(unitRoot, smallConfig());
    await expect(validateNovelScaleFixture(unitRoot)).rejects.toThrow("校验 profile 不匹配");
    await expect(validateUnitFixture(unitRoot)).resolves.toMatchObject({ validationProfile: "unit" });
    expect(() => parseNovelScaleFixtureArgs(["--scale", "S1", "--output", "/tmp/fixture", "--force"])).toThrow("--force 已禁用");
  });

  it("任何已存在输出路径都拒绝覆盖，既有用户文件和完整夹具保持不变", async () => {
    const root = await tempDirectory();
    await mkdir(root);
    await writeFile(path.join(root, "user-file.txt"), "用户数据", "utf8");
    await expect(createNovelScaleFixture(root, smallConfig())).rejects.toThrow("输出路径已存在");
    await expect(readFile(path.join(root, "user-file.txt"), "utf8")).resolves.toBe("用户数据");

    const fixtureRoot = await tempDirectory();
    await createNovelScaleFixture(fixtureRoot, smallConfig());
    const fixtureFiles = ["manifest.json", "corpus.md", "golden-answers.json"] as const;
    const before = Object.fromEntries(await Promise.all(fixtureFiles.map(async (file) => [file, await readFile(path.join(fixtureRoot, file))])));
    await expect(createNovelScaleFixture(fixtureRoot, smallConfig("replacement"))).rejects.toThrow("输出路径已存在");
    for (const file of fixtureFiles) {
      expect(await readFile(path.join(fixtureRoot, file))).toEqual(before[file]);
    }
    const generatorSource = await readFile(path.resolve("scripts/create-novel-scale-fixtures.ts"), "utf8");
    expect(generatorSource).not.toContain("recursive: true, force: true");
    await expect(validateUnitFixture(fixtureRoot)).resolves.toMatchObject({ ok: true });
  });
});
