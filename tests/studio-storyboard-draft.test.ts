import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendStudioScriptRevision,
  createStudioPromptDocument,
  appendStudioPromptRevision,
  createStudioProductionUnit,
  createStudioScriptDocument,
  getStudioProductionState,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import { createStudioCanonicalAsset } from "../src/core/material-studio.js";
import { suggestStudioStoryboardDraft } from "../src/core/studio-storyboard-draft.js";

/**
 * P20 拆格建议器定向测试（规范 v2.1 §4-1..6）。
 * 夹具：临时受管工程 + 剧本修订 + 规范资产（身份索引）。
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "p20-storyboard-draft-"));
  roots.push(root);
  return root;
}

const SENTENCES = [
  "阿航带着完整黄金面具走入石室。",
  "火把的光从左侧墙壁滑落。",
  "他停在三步外，没有立刻伸手。",
  "石台后面传来轻微的金属声。",
  "突然，面具的眼孔里闪过一线反光。",
  "阿航按住胸前的布囊，屏住呼吸。",
  "下一秒，石室尽头的暗门缓缓打开。",
  "他把火把举高，照见门后的长阶。",
  "长阶两侧刻满古老的祭祀纹样。",
  "阿航低声说：别出声。",
  "他踏上第一级台阶，身影没入阴影。",
  "金属声再次响起，这一次更近。",
];

async function scriptFixture(root: string, body = SENTENCES.join("")) {
  const script = await createStudioScriptDocument(root, {
    id: "script-draft",
    title: "EP01 拆格剧本",
    expectedRevision: 0,
  });
  const appended = await appendStudioScriptRevision(root, {
    documentId: script.id,
    expectedRevision: 0,
    body,
    source: "scripts/EP01.md",
    sourceVersion: "v1",
  });
  return { script, scriptRevision: appended.revision };
}

async function variableDurationUnitFixture(root: string, durationSeconds: number) {
  const { scriptRevision } = await scriptFixture(root);
  const prompt = await createStudioPromptDocument(root, {
    id: "prompt-draft",
    title: "拆格提示词",
    expectedRevision: 0,
  });
  const promptRevision = await appendStudioPromptRevision(root, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "电影写实，保持连续。",
    source: "prompts/EP01.txt",
    sourceVersion: "v1",
  });
  const split = Math.round((durationSeconds / 2) * 10) / 10;
  const panels: StudioProductionPanelInput[] = [
    {
      id: "panel-01",
      title: "前半",
      visualAction: "阿航进入石室。",
      shotComposition: "中景。",
      filmingMethod: "稳定跟拍。",
      startSeconds: 0,
      endSeconds: split,
      durationSeconds: split,
      promptRevisionId: promptRevision.revision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 2 }],
      assets: [],
    },
    {
      id: "panel-02",
      title: "后半",
      visualAction: "阿航停步回望。",
      shotComposition: "近景。",
      filmingMethod: "缓慢推近。",
      startSeconds: split,
      endSeconds: durationSeconds,
      durationSeconds: Math.round((durationSeconds - split) * 10) / 10,
      promptRevisionId: promptRevision.revision.id,
      sourceSpans: [{ startOffsetUtf16: 2, endOffsetUtf16: 4 }],
      assets: [],
    },
  ];
  const unit = await createStudioProductionUnit(root, {
    id: "unit-variable-duration",
    expectedRevision: 0,
    season: "S01",
    episode: "E01",
    sequence: 1,
    title: "变长单元",
    durationSeconds,
    scriptRevisionId: scriptRevision.id,
    panels,
  });
  return { scriptRevision, unit };
}

async function assetFixture(root: string): Promise<void> {
  await createStudioCanonicalAsset(root, {
    id: "character-ahang",
    category: "character",
    name: "阿航",
    aliases: ["小航"],
    expectedRevision: 0,
  } as Parameters<typeof createStudioCanonicalAsset>[1]);
  await createStudioCanonicalAsset(root, {
    id: "prop-golden-mask",
    category: "prop",
    name: "黄金面具",
    aliases: ["金面"],
    expectedRevision: 0,
  } as Parameters<typeof createStudioCanonicalAsset>[1]);
}

describe("P20 §4-1 拆格建议：2/4/6 格，spans 可逐字核验，时长严格 15.0", () => {
  for (const panelCount of [2, 4, 6] as const) {
    it(`${panelCount} 格`, async () => {
      const root = await project();
      const { scriptRevision } = await scriptFixture(root);
      const suggestion = await suggestStudioStoryboardDraft(root, {
        scriptRevisionId: scriptRevision.id,
        panelCount,
      });
      expect(suggestion.panels).toHaveLength(panelCount);
      expect(suggestion.scriptRevisionId).toBe(scriptRevision.id);
      expect(suggestion.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

      let cursor = 0;
      for (const [index, panel] of suggestion.panels.entries()) {
        expect(panel.panelIndex).toBe(index + 1);
        expect(panel.shotType).toBe("original");
        expect(panel.startSeconds).toBeCloseTo(cursor, 5);
        expect(panel.durationSeconds).toBeGreaterThanOrEqual(1.0);
        expect(panel.endSeconds).toBeCloseTo(panel.startSeconds + panel.durationSeconds, 5);
        expect(panel.sourceSpans.length).toBeGreaterThan(0);
        // sourceSpans 逐字核验：升序不重叠、非空、可在剧本中精确找回。
        let previousEnd = -1;
        for (const span of panel.sourceSpans) {
          expect(span.startOffsetUtf16).toBeGreaterThanOrEqual(previousEnd);
          const surface = scriptRevision.body.slice(span.startOffsetUtf16, span.endOffsetUtf16);
          expect(surface.trim().length).toBeGreaterThan(0);
          previousEnd = span.endOffsetUtf16;
        }
        cursor = panel.endSeconds;
      }
      expect(cursor).toBeCloseTo(15.0, 5);
    });
  }
});

describe("P30 真实单元时长传播", () => {
  it("unitId 路径按 12 秒分配，script-only 路径保持既有 15 秒语义", async () => {
    const root = await project();
    const { scriptRevision, unit } = await variableDurationUnitFixture(root, 12);
    const byUnit = await suggestStudioStoryboardDraft(root, {
      unitId: unit.unit.id,
      scriptRevisionId: scriptRevision.id,
      panelCount: 3,
    });
    const scriptOnly = await suggestStudioStoryboardDraft(root, {
      scriptRevisionId: scriptRevision.id,
      panelCount: 3,
    });
    expect(byUnit.panels.at(-1)?.endSeconds).toBe(12);
    expect(byUnit.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBeCloseTo(12, 5);
    expect(scriptOnly.panels.at(-1)?.endSeconds).toBe(15);
    expect(scriptOnly.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBeCloseTo(15, 5);
    await expect(suggestStudioStoryboardDraft(root, {
      unitId: unit.unit.id,
      scriptRevisionId: "wrong-script-revision",
      panelCount: 3,
    })).rejects.toThrow(/不一致/u);
  });
});

describe("P20 §4-2 文本不足时末尾 extension 显式建议（禁带 spans）", () => {
  it("2 句文本请求 6 格 → 2 原镜 + 4 末尾 extension", async () => {
    const root = await project();
    const { scriptRevision } = await scriptFixture(root, "阿航走入石室。火把滑落。");
    const suggestion = await suggestStudioStoryboardDraft(root, {
      scriptRevisionId: scriptRevision.id,
      panelCount: 6,
    });
    expect(suggestion.panels).toHaveLength(6);
    expect(suggestion.panels.slice(0, 2).every((panel) => panel.shotType === "original")).toBe(true);
    const extensions = suggestion.panels.slice(2);
    expect(extensions).toHaveLength(4);
    for (const panel of extensions) {
      expect(panel.shotType).toBe("extension");
      expect(panel.sourceSpans).toEqual([]);
      expect(panel.suggestedAssetIds).toEqual([]);
      expect(panel.unresolvedProposals).toEqual([]);
      // 显式约定：extension 建议格时间 0/0/0，Agent 提交前须在 15.0s 总额内重排（工具描述已声明）。
      expect(panel.startSeconds).toBe(0);
      expect(panel.endSeconds).toBe(0);
      expect(panel.durationSeconds).toBe(0);
    }
  });
});

describe("P20 §4-3 资产带入：exact 带入 / ambiguous 不自动选 / unmatched 不带入", () => {
  it("exact matched 带入，别名歧义留 unresolvedProposal 且不自动选择", async () => {
    const root = await project();
    await assetFixture(root);
    await createStudioCanonicalAsset(root, {
      id: "prop-golden-mask-replica",
      category: "prop",
      name: "金面具复刻",
      aliases: ["金面"],
      expectedRevision: 0,
    } as Parameters<typeof createStudioCanonicalAsset>[1]);
    const { scriptRevision } = await scriptFixture(root, "阿航带着黄金面具走入石室。石台上放着另一件金面。");
    const suggestion = await suggestStudioStoryboardDraft(root, {
      scriptRevisionId: scriptRevision.id,
      panelCount: 2,
    });
    const suggested = suggestion.panels.flatMap((panel) => panel.suggestedAssetIds);
    const unresolved = suggestion.panels.flatMap((panel) => panel.unresolvedProposals);
    expect(suggested).toContain("character-ahang");
    expect(suggested).toContain("prop-golden-mask");
    expect(suggested).not.toContain("prop-golden-mask-replica");
    expect(unresolved.length).toBeGreaterThan(0);
    const maskProposal = unresolved.find((proposal) => proposal.surfaceText === "金面");
    expect(maskProposal).toBeDefined();
    expect(maskProposal!.candidateAssetIds).toEqual(expect.arrayContaining(["prop-golden-mask", "prop-golden-mask-replica"]));
    for (const proposal of unresolved) {
      expect(proposal.candidateAssetIds.length).toBeGreaterThan(1);
      // F-R2-01：proposal 偏移必须能逐字切回 surfaceText。
      expect(scriptRevision.body.slice(proposal.startOffsetUtf16, proposal.endOffsetUtf16)).toBe(proposal.surfaceText);
    }
    // F-R2-NEW-01：同格同 surfaceText 提案唯一（共享别名不重复）。
    for (const panel of suggestion.panels) {
      const texts = panel.unresolvedProposals.map((proposal) => proposal.surfaceText);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it("unresolvedProposal 偏移指向正文逐字位置（换行桶内非首句回归）", async () => {
    const root = await project();
    await assetFixture(root);
    await createStudioCanonicalAsset(root, {
      id: "prop-golden-mask-replica",
      category: "prop",
      name: "金面具复刻",
      aliases: ["金面"],
      expectedRevision: 0,
    } as Parameters<typeof createStudioCanonicalAsset>[1]);
    const body = "阿航走入石室。\n金面在暗处闪光。火把滑落照亮墙壁。他屏住呼吸不动。";
    const { scriptRevision } = await scriptFixture(root, body);
    const before = await getStudioProductionState(root);
    const suggestion = await suggestStudioStoryboardDraft(root, {
      scriptRevisionId: scriptRevision.id,
      panelCount: 2,
    });
    const proposal = suggestion.panels
      .flatMap((panel) => panel.unresolvedProposals)
      .find((entry) => entry.surfaceText === "金面");
    expect(proposal).toBeDefined();
    expect(proposal!.startOffsetUtf16).toBe(body.indexOf("金面"));
    expect(body.slice(proposal!.startOffsetUtf16, proposal!.endOffsetUtf16)).toBe("金面");
    // R1-F6b：建议器不调用任何写路径——建议前后生产库计数逐项相等。
    const after = await getStudioProductionState(root);
    expect(after.counts).toEqual(before.counts);
  });
});

describe("P20 §4-4 混合标点与 UTF-16 代理对", () => {
  it("全角/半角/换行对白/emoji 拆句与偏移一致", async () => {
    const root = await project();
    const body = "阿航说：别出声！\n他点头. Fire crackles? 面具🎭反光……他继续前进!\n下一秒门开了。";
    const { scriptRevision } = await scriptFixture(root, body);
    const suggestion = await suggestStudioStoryboardDraft(root, {
      scriptRevisionId: scriptRevision.id,
      panelCount: 3,
    });
    expect(suggestion.panels).toHaveLength(3);
    for (const panel of suggestion.panels) {
      for (const span of panel.sourceSpans) {
        const surface = body.slice(span.startOffsetUtf16, span.endOffsetUtf16);
        expect(surface.trim().length).toBeGreaterThan(0);
        expect(Number.isSafeInteger(span.startOffsetUtf16)).toBe(true);
        expect(Number.isSafeInteger(span.endOffsetUtf16)).toBe(true);
      }
    }
    const reconstructed = suggestion.panels.flatMap((panel) => panel.sourceSpans).map((span) => body.slice(span.startOffsetUtf16, span.endOffsetUtf16)).join("");
    expect(reconstructed.replace(/\s/gu, "")).toBe(body.replace(/\s/gu, ""));
  });

  it("连续终止符归并：半角省略号不产生垃圾句", async () => {
    const root = await project();
    const body = "他停下等等...火光闪过。面具反光……他继续。";
    const { scriptRevision } = await scriptFixture(root, body);
    const suggestion = await suggestStudioStoryboardDraft(root, {
      scriptRevisionId: scriptRevision.id,
      panelCount: 2,
    });
    const surfaces = suggestion.panels.flatMap((panel) =>
      panel.sourceSpans.map((span) => body.slice(span.startOffsetUtf16, span.endOffsetUtf16)));
    expect(surfaces.some((surface) => surface.includes("等等..."))).toBe(true);
    for (const surface of surfaces) {
      expect(surface).not.toMatch(/^[.!?…。！？]+$/u);
    }
    expect(surfaces.join("").replace(/\s/gu, "")).toBe(body.replace(/\s/gu, ""));
  });
});

describe("P20 §4-5 失败路径与时长边界", () => {
  it("空文本/缺失 revision/超长文本/非法 panelCount 全部 fail-closed", async () => {
    const root = await project();
    await expect(scriptFixture(root, "   ")).rejects.toThrow(/不能为空/u);
    await expect(suggestStudioStoryboardDraft(root, { scriptRevisionId: "missing-revision" })).rejects.toThrow(/不存在/u);
    const longRoot = await project();
    const longBody = "阿航走入石室。".repeat(8_000);
    const { scriptRevision: longRevision } = await scriptFixture(longRoot, longBody);
    await expect(suggestStudioStoryboardDraft(longRoot, { scriptRevisionId: longRevision.id })).rejects.toThrow(/上限/u);
    const normalRoot = await project();
    const { scriptRevision: normal } = await scriptFixture(normalRoot);
    await expect(suggestStudioStoryboardDraft(normalRoot, { scriptRevisionId: normal.id, panelCount: 7 })).rejects.toThrow(/2-6/u);
    await expect(suggestStudioStoryboardDraft(normalRoot, {})).rejects.toThrow(/至少其一必填/u);
    const singleRoot = await project();
    const { scriptRevision: single } = await scriptFixture(singleRoot, "只有一句。");
    await expect(suggestStudioStoryboardDraft(singleRoot, { scriptRevisionId: single.id, panelCount: 4 })).rejects.toThrow(/不足拆为至少 2 个原镜格/u);
  });

  it("极端句长触发 1.0s 最小格 clamp 与从最大格重分配；纯函数同输入同输出", async () => {
    const root = await project();
    const longSentence = "阿航带着完整黄金面具走入石室，火把的光从左侧墙壁缓缓滑落，他停在三步外没有伸手，石台后面传来轻微的金属声，他屏住呼吸不敢动弹。";
    const body = `${longSentence}他点头。火光暗了。门开了。他走了。`;
    const { scriptRevision } = await scriptFixture(root, body);
    const first = await suggestStudioStoryboardDraft(root, { scriptRevisionId: scriptRevision.id, panelCount: 5 });
    const second = await suggestStudioStoryboardDraft(root, { scriptRevisionId: scriptRevision.id, panelCount: 5 });
    expect(second).toEqual(first);
    expect(second.fingerprint).toBe(first.fingerprint);
    const durations = first.panels.map((panel) => panel.durationSeconds);
    // clamp 真实触发：四个极短格被钳到 1.0s，长格承担重分配。
    expect(durations).toContain(1.0);
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(1.0);
    expect(Math.max(...durations)).toBeGreaterThan(1.0);
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeCloseTo(15.0, 5);
  });
});

describe("P20 §4-6 unitId 解析路径", () => {
  it("unitId 给定时用单元锚定的剧本修订", async () => {
    const root = await project();
    const { scriptRevision } = await scriptFixture(root);
    const prompt = await createStudioPromptDocument(root, { id: "prompt-draft", title: "提示词", expectedRevision: 0 });
    const promptAppended = await appendStudioPromptRevision(root, {
      documentId: prompt.id,
      expectedRevision: 0,
      body: "电影写实。",
      source: "prompts/a.txt",
      sourceVersion: "v1",
    });
    const panels: StudioProductionPanelInput[] = [0, 7.5].map((start, offset) => ({
      title: `镜头 ${offset + 1}`,
      visualAction: "阿航走入石室。",
      shotComposition: "中景。",
      filmingMethod: "固定机位。",
      startSeconds: start,
      durationSeconds: 7.5,
      promptRevisionId: promptAppended.revision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptRevision.body.length }],
      assets: [],
    }));
    const unit = await createStudioProductionUnit(root, {
      season: "season-three",
      episode: "ep01",
      sequence: 1,
      title: "拆格来源单元",
      scriptRevisionId: scriptRevision.id,
      panels,
      expectedRevision: 0,
    });
    const suggestion = await suggestStudioStoryboardDraft(root, { unitId: unit.unit.id, panelCount: 2 });
    expect(suggestion.scriptRevisionId).toBe(scriptRevision.id);
    expect(suggestion.panels).toHaveLength(2);
  });
});
