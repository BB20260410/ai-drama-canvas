import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createStudioLexicalIdentityMatcher,
  normalizeStudioLexicalTextWithUtf16Map,
} from "../src/core/studio-identity-lexical-index.js";

describe("studio exact identity lexical index", () => {
  it("保持 NFKC、空白、emoji UTF-16 offset 与 ASCII 词边界", () => {
    const groups = [
      { key: "阿航", category: "character", assetIds: ["character-ahang"] },
      { key: "ahang", category: "character", assetIds: ["character-ahang"] },
      { key: "石室", category: "scene", assetIds: ["scene-stone-room"] },
      { key: "布囊", category: "prop", assetIds: ["prop-bag"] },
    ] as const;
    const matcher = createStudioLexicalIdentityMatcher(groups);
    const source = "😀ＡＨＡＮＧ 走近石室，阿航拿起布囊；Xahang 不应命中。";
    const matches = matcher.match(source, 100);
    expect(matches.map((match) => ({
      key: match.group.key,
      surface: match.surfaceText,
      start: match.start,
      end: match.end,
    }))).toEqual([
      { key: "ahang", surface: "ＡＨＡＮＧ", start: 102, end: 107 },
      { key: "石室", surface: "石室", start: 110, end: 112 },
      { key: "阿航", surface: "阿航", start: 113, end: 115 },
      { key: "布囊", surface: "布囊", start: 117, end: 119 },
    ]);
    expect(normalizeStudioLexicalTextWithUtf16Map("  Ａ  \n Ｂ  ").text).toBe("a b");
  });

  it("保留同词跨类别歧义、后缀命中与稳定顺序", () => {
    const matcher = createStudioLexicalIdentityMatcher([
      { key: "黄金面具", category: "prop", assetIds: ["prop-mask"] },
      { key: "面具", category: "prop", assetIds: ["prop-mask"] },
      { key: "祭坛", category: "scene", assetIds: ["scene-altar"] },
      { key: "祭坛", category: "prop", assetIds: ["prop-mini-altar"] },
    ]);
    expect(matcher.match("黄金面具在祭坛").map((match) => `${match.start}:${match.end}:${match.group.category}:${match.group.key}`))
      .toEqual([
        "0:4:prop:黄金面具",
        "2:4:prop:面具",
        "5:7:prop:祭坛",
        "5:7:scene:祭坛",
      ]);
  });

  it("10k assets / 30k identities / 6 panels 有界扫描并留下 p95、内存和索引规模证据", () => {
    const groupCount = 30_000;
    const assetCount = 10_000;
    const groups = Array.from({ length: groupCount }, (_, index) => ({
      key: `实体${String(index).padStart(5, "0")}`,
      category: index % 3 === 0 ? "character" : index % 3 === 1 ? "scene" : "prop",
      assetIds: [`asset-${String(index % assetCount).padStart(5, "0")}`],
    }));
    const heapBefore = process.memoryUsage().heapUsed;
    const buildStarted = performance.now();
    const matcher = createStudioLexicalIdentityMatcher(groups);
    const buildMs = performance.now() - buildStarted;
    const samples: number[] = [];
    for (let panel = 0; panel < 6; panel += 1) {
      const source = `第${panel + 1}格：实体${String(panel * 4_999).padStart(5, "0")}与实体${String(29_999 - panel * 3_997).padStart(5, "0")}同框，背景没有其他规范资产。`;
      const started = performance.now();
      const matches = matcher.match(source);
      samples.push(performance.now() - started);
      expect(matches).toHaveLength(2);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    const evidence = {
      assets: new Set(groups.flatMap((group) => group.assetIds)).size,
      groups: matcher.groupCount,
      nodes: matcher.nodeCount,
      panels: samples.length,
      buildMs: Number(buildMs.toFixed(3)),
      p95Ms: Number(p95Ms.toFixed(3)),
      heapDeltaBytes,
    };
    process.stdout.write(`P6_IDENTITY_TRIE_BENCHMARK ${JSON.stringify(evidence)}\n`);
    expect(evidence.assets).toBe(assetCount);
    expect(matcher.groupCount).toBe(groupCount);
    expect(matcher.nodeCount).toBeLessThan(groupCount * 10);
    expect(buildMs).toBeLessThan(5_000);
    expect(p95Ms).toBeLessThan(500);
    expect(heapDeltaBytes).toBeLessThan(512 * 1024 * 1024);
  });

  it("输入重复或命中过量时失败关闭，不静默截断", () => {
    expect(() => createStudioLexicalIdentityMatcher([
      { key: "阿航", category: "character", assetIds: ["a"] },
      { key: "阿航", category: "character", assetIds: ["b"] },
    ])).toThrow(/重复/u);
    const matcher = createStudioLexicalIdentityMatcher([
      { key: "阿", category: "character", assetIds: ["a"] },
    ]);
    expect(() => matcher.match("阿阿", 0, 1)).toThrow(/拒绝截断/u);
  });
});
