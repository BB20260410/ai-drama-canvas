import { describe, expect, it, beforeEach } from "vitest";
import { createStudioAgentToolFactory } from "../src/core/studio-agent-tool-factory.js";
import {
  clearStudioMediaAdapterRegistryForTests,
  createMockMediaAdapter,
  ensureDefaultMockAdaptersRegistered,
  getStudioMediaAdapter,
  listStudioMediaAdapters,
  registerStudioMediaAdapter,
} from "../src/core/studio-media-provider-adapter.js";
import {
  loadStudioPromptTemplateFromMarkdown,
  renderStudioPromptTemplate,
} from "../src/core/studio-prompt-templates.js";
import { validateWithRefeed } from "../src/core/studio-schema-retry.js";
import { planPanelContinueBatches } from "../src/core/studio-panel-batch-continue.js";
import {
  splitDialogueForTts,
  wordsToSrt,
  validateVoiceIdentity,
  planEpisodeMerge,
  getSubtitleStylePreset,
  verticalEncodeRecipe,
  validateFlf2vContract,
  validateLastFrameLineage,
  planAnimatic,
  planBgmDucking,
} from "../src/core/studio-fusion-p2-finish.js";
import {
  aggregateConsistencyScores,
  buildCharacterPromptBatch,
  validateLoraRecipe,
  assertAssetRelation,
  authorityBadge,
  wrapCaption,
  applyStyleTemplate,
  planMultiAngleBoard,
  buildGcReportPure,
  ipAdapterStrategyFor,
  buildW3cAnnotation,
  assertCompareMode,
  openReworkFromAnnotation,
  validateTemporalRange,
  reviewPipelineLabel,
  buildPngIdentityTextChunks,
  buildReviewReportMarkdown,
} from "../src/core/studio-fusion-p3-p4.js";
import {
  layoutNewNodeBeside,
  snapToGrid,
  applyHistoryDeltas,
  serializeCanvasContextForAgent,
  lruPut,
  expandBatchCartesian,
  acquireLease,
  isLeaseExpired,
  replayDurableEvents,
  shouldSkipStep,
  assertProgress,
  jobKeyFor,
  quarantineRequiredForMode,
  planOtioExport,
  planProjectPackage,
  clusterSetupsByCamera,
  compressLongTextLayers,
  pickBeatTemplate,
  assertFragmentDuration,
  resolveAlias,
  registerPromptVersion,
  estimateWorkload,
  validateShotContinuityRule,
  publicationPreflightLocal,
  maskSecret,
  i18nToolDescription,
  structuredTaskLog,
} from "../src/core/studio-fusion-p5-p9.js";
import {
  exploreModePolicy,
  validateFineControlPanel,
  sequenceReorder,
} from "../src/core/studio-fusion-p10-optional.js";

describe("P1.5 tool factory", () => {
  it("注入上下文并属集校验", () => {
    const f = createStudioAgentToolFactory({
      unitId: "U1",
      episodeId: "E1",
      allowedCharacterIds: ["character-a"],
      allowedSceneIds: ["scene-a"],
    });
    expect(f.tools.length).toBeGreaterThan(2);
    expect(() => f.assertInScope("character", "character-a")).not.toThrow();
    expect(() => f.assertInScope("character", "outsider")).toThrow(/不属于/);
  });
});

describe("P1.7 adapter registry", () => {
  beforeEach(() => clearStudioMediaAdapterRegistryForTests());
  it("mock 注册与解析", () => {
    ensureDefaultMockAdaptersRegistered();
    expect(listStudioMediaAdapters("image")).toHaveLength(1);
    const a = getStudioMediaAdapter("mock-image")!;
    const built = a.buildGenerate({ kind: "image", prompt: "test cat" });
    expect(built.url).toMatch(/^mock:/);
    const parsed = a.parseGenerate({ ok: true, path: "/q/x.png" });
    expect(parsed.status).toBe("ready");
    expect(() => registerStudioMediaAdapter(createMockMediaAdapter("image", "mock-image"))).toThrow(/重复/);
  });
});

describe("P1.8 templates", () => {
  it("加载 frontmatter 并渲染", () => {
    const t = loadStudioPromptTemplateFromMarkdown(`---
name: demo
description: d
---
Hello {{who}}
`);
    expect(t.name).toBe("demo");
    expect(renderStudioPromptTemplate(t, { who: "世界" })).toBe("Hello 世界");
    expect(() => renderStudioPromptTemplate(t, {})).toThrow(/未替换/);
  });
});

describe("P1.9 refeed", () => {
  it("缺字段生成 refeedMessage", () => {
    const r = validateWithRefeed({}, [{ key: "title", required: true, type: "string", minLength: 2 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refeedMessage).toMatch(/title/);
  });
  it("通过", () => {
    const r = validateWithRefeed({ title: "ab" }, [{ key: "title", required: true, type: "string", minLength: 2 }]);
    expect(r.ok).toBe(true);
  });
});

describe("P1.10 batches", () => {
  it("6 格 batchSize 2 → 3 批", () => {
    const b = planPanelContinueBatches(6, 2);
    expect(b).toHaveLength(3);
    expect(b[2]!.ordinals).toEqual([5, 6]);
  });
  it("非法格数 fail-close", () => {
    expect(() => planPanelContinueBatches(1)).toThrow(/2–6/);
  });
});

describe("P2 finish contracts", () => {
  it("tts split / srt / voice / merge / presets / flf / lineage / animatic / duck", () => {
    expect(splitDialogueForTts("你好。世界！").length).toBe(2);
    expect(wordsToSrt([{ word: "你", start: 0, end: 0.2 }, { word: "好", start: 0.2, end: 0.5 }])).toMatch(/你好/);
    expect(() => validateVoiceIdentity({ voiceId: "v1", engine: "mock", defaultSpeed: 1 })).not.toThrow();
    expect(planEpisodeMerge(["a.mp4", "b.mp4"], "out.mp4").loudnorm.integratedLufs).toBe(-14);
    expect(getSubtitleStylePreset("drama-white-outline").fontSize).toBe(48);
    expect(verticalEncodeRecipe().crf).toBe(18);
    expect(() =>
      validateFlf2vContract({
        firstFramePath: "f.png",
        lastFramePath: "l.png",
        prompt: "walk",
        frames: 81,
        fps: 16,
        width: 1280,
        height: 720,
      }),
    ).not.toThrow();
    expect(() =>
      validateLastFrameLineage({
        sourceVideoHash: "a".repeat(64),
        frameIndex: 10,
        extractedAt: "t",
      }),
    ).not.toThrow();
    expect(planAnimatic([{ path: "1.png", durationSeconds: 1 }, { path: "2.png", durationSeconds: 2 }]).totalSeconds).toBe(3);
    expect(planBgmDucking().filter).toMatch(/sidechain/);
  });
});

describe("P3-P4 contracts", () => {
  it("consistency / batch / lora / relations / badge / caption / style / gc / ip / review", () => {
    expect(aggregateConsistencyScores([{ verdict: "consistent" }, { verdict: "drifted" }])).toBe("drifted");
    expect(buildCharacterPromptBatch([{ id: "c1", name: "A" }], ["pose"]).length).toBe(1);
    expect(() => validateLoraRecipe({ triggerWord: "sks", dim: 16, alpha: 16, learningRate: 1e-4, steps: 1000 })).not.toThrow();
    expect(() => assertAssetRelation("versionOf", "a", "b")).not.toThrow();
    expect(authorityBadge({ isAuthority: true, sha256: "abcd1234ff", revision: 9 }).locked).toBe(true);
    expect(wrapCaption("一二三四五六七八九十", 4)).toHaveLength(3);
    expect(applyStyleTemplate("cinematic", "a girl").negative).toMatch(/水印/);
    expect(planMultiAngleBoard(["front", "side"]).cells).toBe(2);
    expect(buildGcReportPure(["a"], ["a", "b"]).orphans).toEqual(["b"]);
    expect(ipAdapterStrategyFor("character")).toBe("face-id");
    expect(buildW3cAnnotation({ x: 1, y: 2, w: 3, h: 4, tSeconds: 1.5, body: "漂" }).target.selector).toMatch(/t=1.5/);
    expect(assertCompareMode("wipe")).toBe("wipe");
    expect(openReworkFromAnnotation("ann1", "p1").newRunRequired).toBe(true);
    expect(() => validateTemporalRange(1, 3)).not.toThrow();
    expect(reviewPipelineLabel("retake")).toBe("重拍");
    expect(buildPngIdentityTextChunks({ packId: "p", runId: "r", panelId: "g" }).aicanvas_packId).toBe("p");
    expect(buildReviewReportMarkdown([{ panelId: "g1", decision: "pass" }])).toMatch(/审片报告/);
  });
});

describe("P5-P9 contracts", () => {
  it("canvas / queue / export / adapt / ops", () => {
    expect(layoutNewNodeBeside({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 50 }).x).toBe(84);
    expect(snapToGrid(13, 8)).toBe(16);
    expect(applyHistoryDeltas({ a: 1 }, [{ id: "a", before: 0, after: 1 }], "undo").a).toBe(0);
    expect(serializeCanvasContextForAgent({ selectedNodeIds: ["n1"], viewport: { x: 0, y: 0, w: 1, h: 1 }, nodeSummaries: [{ id: "n1", kind: "unit", label: "U" }] })).toMatch(/n1/);
    const lru = lruPut(new Map([["a", 1]]), "b", 2, 1);
    expect(lru.evicted).toBe("a");
    expect(expandBatchCartesian({ seed: [1, 2], style: ["x"] })).toHaveLength(2);
    const lease = acquireLease(1000, "worker", 100);
    expect(isLeaseExpired(lease, 1100)).toBe(true);
    const done = replayDurableEvents([{ id: "1", step: "a", payload: {} }]);
    expect(shouldSkipStep(done, "a")).toBe(true);
    expect(() => assertProgress({ token: "t", progress: 1, total: 2 })).not.toThrow();
    expect(jobKeyFor(["u", "g", "1"])).toBe("u:g:1");
    expect(quarantineRequiredForMode("explore")).toBe(true);
    expect(planOtioExport(3).clips).toBe(3);
    expect(planProjectPackage(["a", "b"]).manifestCount).toBe(2);
    expect(clusterSetupsByCamera([{ id: "s1", fov: 50, height: 1.6 }, { id: "s2", fov: 51, height: 1.6 }])[0]!.shotIds).toHaveLength(2);
    expect(compressLongTextLayers("hello world").chunks.length).toBeGreaterThan(0);
    expect(pickBeatTemplate(0)).toMatch(/钩子/);
    expect(() => assertFragmentDuration(10)).not.toThrow();
    expect(resolveAlias("阿航", [{ canonical: "character-r01", aliases: ["阿航"] }])).toBe("character-r01");
    expect(registerPromptVersion([], "sys", "body").version).toBe(1);
    expect(estimateWorkload(1000).approxPanels).toBeGreaterThan(0);
    expect(validateShotContinuityRule([{ shotType: "close_up" }]).length).toBeGreaterThan(0);
    expect(publicationPreflightLocal({ width: 1080, height: 1920, durationSeconds: 15, lufs: -14 }).ok).toBe(true);
    expect(maskSecret("sk-abcdefghijk")).toMatch(/…/);
    expect(i18nToolDescription("中文", "English", "en")).toBe("English");
    expect(structuredTaskLog({ task: "t", phase: "p", ok: true })).toMatch(/"task":"t"/);
  });
});

describe("P10 optional", () => {
  it("explore quarantine + sequence", () => {
    expect(exploreModePolicy().forceQuarantine).toBe(true);
    expect(() => validateFineControlPanel({ region: { x: 0, y: 0, w: 10, h: 10 } })).not.toThrow();
    expect(sequenceReorder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
});
