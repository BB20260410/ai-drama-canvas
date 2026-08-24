import { describe, expect, it } from "vitest";
import { auditDuduReadonlyUnitProjection } from "../src/core/dudu-readonly-import.js";
import type {
  DuduParsedPanel,
  DuduReadonlyUnitSource,
  DuduReferenceAsset,
} from "../src/core/dudu-readonly-source.js";
import {
  assertDuduPromptTextPathFree,
  auditDuduV2BindingSafetyClosure,
  duduFindSemanticTokenRange,
  duduReferencePresenceForPanel,
  duduStudioCategoryForSourceType,
  duduTextIncludesSemanticToken,
} from "../src/core/dudu-readonly-source.js";

function asset(input: Partial<DuduReferenceAsset> & Pick<DuduReferenceAsset, "id" | "name" | "category" | "sourceType" | "referenceRole">): DuduReferenceAsset {
  return {
    relativePath: `refs/${input.id}.png`,
    absolutePath: `/readonly/refs/${input.id}.png`,
    sha256: input.id.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/gu, "a"),
    status: "APPROVED",
    inherit: `保持 ${input.name} 的批准外观。`,
    forbid: `禁止改变 ${input.name}。`,
    aliases: [input.id, input.name],
    ...input,
  };
}

function panel(input: {
  id: string;
  index: number;
  start: number;
  end: number;
  sourceText: string;
  fields: Record<string, string>;
}): DuduParsedPanel {
  return {
    id: input.id,
    index: input.index,
    durationSeconds: input.end - input.start,
    startSeconds: input.start,
    endSeconds: input.end,
    sourceStartOffsetUtf16: input.index === 1 ? 0 : 1_000,
    sourceEndOffsetUtf16: (input.index === 1 ? 0 : 1_000) + input.sourceText.length,
    fields: input.fields,
    sourceText: input.sourceText,
  };
}

function unitFixture(overrides: Partial<DuduReadonlyUnitSource> = {}): DuduReadonlyUnitSource {
  const character = asset({
    id: "char-dudu-user-locked-v1",
    name: "嘟嘟",
    category: "character",
    sourceType: "character",
    referenceRole: "CHARACTER_IDENTITY",
  });
  const scene = asset({
    id: "scene-shixue-root-detail-v1",
    name: "石穴树根",
    category: "scene",
    sourceType: "scene_detail",
    referenceRole: "SCENE_DETAIL",
  });
  const style = asset({
    id: "style-ref-4",
    name: "电影写实画风",
    category: "prop",
    sourceType: "style",
    referenceRole: "STYLE_ONLY",
  });
  const lockedPanels = [
    panel({
      id: "S1E01-U99-G1",
      index: 1,
      start: 0,
      end: 7,
      sourceText: "### G1\n| 构图 | 嘟嘟躺在石穴树根旁 |\n| 光线 | 暖金 |\n| 色彩 | 暖褐 |\n| 对话 | 【母】不要回头。 |",
      fields: { 构图: "嘟嘟躺在石穴树根旁", 动作: "嘟嘟抬头", 光线: "暖金", 色彩: "暖褐", 对话: "【母】不要回头。" },
    }),
    panel({
      id: "S1E01-U99-G2",
      index: 2,
      start: 7,
      end: 15,
      sourceText: "### G2\n| 构图 | 纯黑独立成格 |\n| 光线 | 纯黑 |\n| 旁白 | 一句不应进入视觉提示词的声音。 |",
      fields: { 构图: "纯黑独立成格", 动作: "无", 光线: "纯黑", 色彩: "纯黑", 旁白: "一句不应进入视觉提示词的声音。" },
    }),
  ];
  const visualPanels = [
    { ...lockedPanels[0]!, fields: { ...lockedPanels[0]!.fields, 连续性: "identity=v1；meteor_vfx=OFF" } },
    { ...lockedPanels[1]!, fields: { ...lockedPanels[1]!.fields, 连续性: "无角色；meteor_vfx=OFF" } },
  ];
  return {
    unitId: "S1E01-U99",
    sequence: 100,
    title: "测试单元",
    durationSeconds: 15,
    episodeStartSeconds: 0,
    episodeEndSeconds: 15,
    panelCount: 2,
    sourceStartOffsetUtf16: 0,
    sourceEndOffsetUtf16: 2_000,
    panels: lockedPanels,
    visualExecutionPanels: visualPanels,
    machineState: {},
    binding: {
      format: "legacy",
      file: {
        scope: "production-root",
        relativePath: "05_提示词/S1E01-U99_BindingSet.md",
        absolutePath: "/readonly/05_提示词/S1E01-U99_BindingSet.md",
        sha256: "b".repeat(64),
        sizeBytes: 100,
      },
      body: "# BindingSet\n1. G1 使用嘟嘟、石穴树根和电影写实画风。\n2. G2 纯黑，无实体。",
      lifecycle: "HISTORICAL_PASS_ONLY",
      version: "legacy",
      attemptBudget: null,
    },
    forbiddenReferences: [],
    references: [character, scene, style],
    historicalPass: null,
    ...overrides,
  };
}

describe("Dudu readonly import projection", () => {
  it("uses real semantic anchors, keeps panel assets out of the projection, and identifies confirmed-empty", () => {
    const audit = auditDuduReadonlyUnitProjection(unitFixture());
    expect(audit).toMatchObject({
      unitId: "S1E01-U99",
      panelCount: 2,
      bindingSetCount: 2,
      confirmedEmptyPanelIds: ["S1E01-U99-G2"],
      mentionCount: 3,
    });
    expect(audit.selectedAssetIds).toEqual([
      "char-dudu-user-locked-v1",
      "scene-shixue-root-detail-v1",
      "style-ref-4",
    ]);
    expect(duduStudioCategoryForSourceType("character")).toBe("character");
    for (const sourceType of ["scene", "scene_detail", "scene_rule"]) {
      expect(duduStudioCategoryForSourceType(sourceType)).toBe("scene");
    }
    for (const sourceType of ["prop", "key_non_character_element", "style"]) {
      expect(duduStudioCategoryForSourceType(sourceType)).toBe("prop");
    }
    expect(Object.keys(audit.promptSha256ByPanelId)).toEqual(["S1E01-U99-G1", "S1E01-U99-G2"]);
  });

  it("fails closed when a character or prop has no real locked-script anchor", () => {
    const fixture = unitFixture();
    const prop = asset({
      id: "mystery-prop-v1",
      name: "神秘道具",
      category: "prop",
      sourceType: "prop",
      referenceRole: "PROP_IDENTITY",
      aliases: ["mystery-prop-v1", "神秘道具"],
    });
    fixture.references = [...fixture.references, prop];
    fixture.binding = {
      ...fixture.binding!,
      body: `${fixture.binding!.body}\n1. G1 必须使用 mystery-prop-v1。`,
    };
    expect(() => auditDuduReadonlyUnitProjection(fixture)).toThrow(/缺少可解释、唯一的 UTF-16 语义片段/u);
  });

  it("does not claim confirmed-empty for units that have no frozen external BindingSet", () => {
    const fixture = unitFixture({ binding: null, references: [] });
    const audit = auditDuduReadonlyUnitProjection(fixture);
    expect(audit.bindingSetCount).toBe(0);
    expect(audit.confirmedEmptyPanelIds).toEqual([]);
    expect(audit.mentionCount).toBe(0);
  });

  it("freezes the v2 raw-grid contract and projects U29 offscreen mother/cub as forbidden without control references", () => {
    const shuo = asset({
      id: "char-shuo-user-locked-v1",
      name: "朔",
      category: "character",
      sourceType: "character",
      referenceRole: "CHARACTER_IDENTITY",
    });
    const scene = asset({
      id: "scene-shixue-interior-night-v1",
      name: "夜间石穴",
      category: "scene",
      sourceType: "scene",
      referenceRole: "SCENE_TOPOLOGY",
    });
    const su = asset({
      id: "char-su-user-locked-v1",
      name: "素",
      category: "character",
      sourceType: "character",
      referenceRole: "CHARACTER_IDENTITY",
    });
    const dudu = asset({
      id: "char-dudu-user-locked-v1",
      name: "嘟嘟",
      category: "character",
      sourceType: "character",
      referenceRole: "CHARACTER_IDENTITY",
    });
    const lockedPanels = [
      panel({
        id: "S1E01-U29-G1", index: 1, start: 0, end: 5,
        sourceText: "### S1E01-U29-G1\n| 构图 | 父在画右洞口守夜，母在画外，崽的窝在洞内深处 |",
        fields: { 构图: "父在画右洞口守夜，窝在洞内深处", 动作: "父静守", 光线: "冷蓝月光", 色彩: "冷蓝＋暖暗" },
      }),
      panel({
        id: "S1E01-U29-G2", index: 2, start: 5, end: 10,
        sourceText: "### S1E01-U29-G2\n| 构图 | 父回头看向洞内 |\n| 动作 | 目光在母身上停一拍，在崽身上多停一拍 |",
        fields: { 构图: "父回头看向洞内", 动作: "目光在母身上停一拍，在崽身上多停一拍", 光线: "月光半脸", 色彩: "冷蓝＋暖暗" },
      }),
      panel({
        id: "S1E01-U29-G3", index: 3, start: 10, end: 15,
        sourceText: "### S1E01-U29-G3\n| 构图 | 父转回洞外，母在画外方向，崽留在窝中 |",
        fields: { 构图: "父转回洞外，一家人留在洞内", 动作: "父继续守夜", 光线: "月光", 色彩: "冷蓝＋暖暗" },
      }),
    ];
    const rawGridPrompt = "生成竖向9:16三格故事板，唯一角色是朔v1；无素、无嘟嘟完整角色，左后藤窝只有暖暗。";
    const fixture = unitFixture({
      unitId: "S1E01-U29",
      sequence: 30,
      panelCount: 3,
      panels: lockedPanels,
      visualExecutionPanels: lockedPanels.map((entry) => ({ ...entry, fields: { ...entry.fields, 连续性: "meteor_vfx=OFF" } })),
      binding: {
        format: "v2",
        file: {
          scope: "production-root",
          relativePath: "05_提示词/S1E01-U29_BindingSet_v2.md",
          absolutePath: "/readonly/05_提示词/S1E01-U29_BindingSet_v2.md",
          sha256: "c".repeat(64),
          sizeBytes: 1_000,
        },
        body: [
          "## A. 权威与边界",
          "不得让素/嘟嘟完整入画。",
          "## C. 身份与空间",
          "朔保持批准身份，藤窝只有暖暗。",
          "## D. 逐格导演谱",
          "### S1E01-U29-G2",
          "母与崽都只作画外目光目标。",
          "## E. raw宫格中文提示词",
          rawGridPrompt,
          "## G. 验收",
          "身份漂移为硬失败。",
        ].join("\n"),
        rawGridPrompt,
        lifecycle: "FROZEN_READY",
        version: "v2.1",
        attemptBudget: 2,
      },
      references: [shuo, scene],
      forbiddenReferences: [su, dudu].map((entry) => ({
        asset: entry,
        panelIndexes: [1, 2, 3],
        evidence: [{ section: "E" as const, text: rawGridPrompt }],
      })),
    });

    const audit = auditDuduReadonlyUnitProjection(fixture);
    for (const panelId of ["S1E01-U29-G1", "S1E01-U29-G2", "S1E01-U29-G3"]) {
      expect(audit.forbiddenAssetIdsByPanelId[panelId]).toEqual([
        "char-dudu-user-locked-v1",
        "char-su-user-locked-v1",
      ]);
      const mentions = audit.extractedMentionsByPanelId[panelId]!;
      expect(mentions.filter((entry) => entry.presence === "forbidden").map((entry) => entry.assetId).sort()).toEqual([
        "char-dudu-user-locked-v1",
        "char-su-user-locked-v1",
      ]);
      expect(mentions.filter((entry) => entry.presence !== "forbidden").map((entry) => entry.assetId).sort()).toEqual([
        "char-shuo-user-locked-v1",
        "scene-shixue-interior-night-v1",
      ]);
      expect(mentions.every((entry) => entry.candidateAssetIds[0] === entry.assetId
        && entry.endOffsetUtf16 > entry.startOffsetUtf16 && entry.surfaceText.trim() === entry.surfaceText)).toBe(true);
    }
    expect(audit.promptBodyByPanelId["S1E01-U29-G2"]).toContain(rawGridPrompt);
    expect(audit.promptBodyByPanelId["S1E01-U29-G2"]).toContain("不得作为控制参考上传");
    expect(audit.promptBodyByPanelId["S1E01-U29-G2"]).not.toContain(`${su.id} / ${su.referenceRole} / forbidden / SHA`);
    expect(audit.selectedAssetIds).toEqual([
      "char-dudu-user-locked-v1",
      "char-shuo-user-locked-v1",
      "char-su-user-locked-v1",
      "scene-shixue-interior-night-v1",
    ]);
  });

  it("parses scoped v2 safety rules without treating 母版 as the mother character", () => {
    const shuo = asset({ id: "char-shuo-user-locked-v1", name: "朔", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const su = asset({ id: "char-su-user-locked-v1", name: "素", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const panels = [1, 2, 3].map((index) => panel({
      id: `S1E01-U98-G${index}`,
      index,
      start: (index - 1) * 5,
      end: index * 5,
      sourceText: `### S1E01-U98-G${index}\n| 构图 | ${index === 3 ? "朔望向画外的素方向" : "朔在洞口"} |`,
      fields: { 构图: "朔在洞口", 动作: "朔静守" },
    }));
    const base = [
      "## A. 权威与边界",
      "禁止改变角色身份母版。",
      "## D. 逐格导演谱",
      "### S1E01-U98-G1",
      "朔静守。",
      "### S1E01-U98-G2",
      "朔回头。",
      "### S1E01-U98-G3",
      "朔转回。",
      "## E. raw宫格中文提示词",
      "生成朔守夜三格；严格继承角色身份母版。",
    ].join("\n");
    expect(auditDuduV2BindingSafetyClosure({
      bindingBody: base,
      unitId: "S1E01-U98",
      panelCount: 3,
      panels,
      allowed: [shuo],
      registryAssets: [shuo, su],
    }).forbiddenReferences).toEqual([]);

    const scoped = base.replace("朔转回。", "朔转回；素全程画外。");
    const parsed = auditDuduV2BindingSafetyClosure({
      bindingBody: scoped,
      unitId: "S1E01-U98",
      panelCount: 3,
      panels,
      allowed: [shuo],
      registryAssets: [shuo, su],
    });
    expect(parsed.forbiddenReferences).toHaveLength(1);
    expect(parsed.forbiddenReferences[0]).toMatchObject({ asset: { id: su.id }, panelIndexes: [3] });
  });

  it("uses one semantic matcher across false-positive words, presence, panel anchoring, and UTF-16 spans", () => {
    const falseCases = [
      ["朔风掠过洞口", "朔"],
      ["父级节点保持不变", "父"],
      ["采用朴素的素色画面", "素"],
      ["身份母版与字母标记不入画", "母"],
      ["使用鱼眼镜头", "鱼"],
    ] as const;
    for (const [text, token] of falseCases) {
      expect(duduTextIncludesSemanticToken(text, token), `${text}/${token}`).toBe(false);
      expect(duduFindSemanticTokenRange(text, token), `${text}/${token}`).toBeNull();
    }
    const positiveCases = [
      ["朔在洞口守夜", "朔"],
      ["父回头看向洞内", "父"],
      ["素全程画外", "素"],
      ["母在画外方向", "母"],
      ["烤鱼放在石边", "鱼"],
    ] as const;
    for (const [text, token] of positiveCases) {
      const range = duduFindSemanticTokenRange(text, token);
      expect(range && text.slice(range.start, range.end), `${text}/${token}`).toBe(token);
    }

    const su = asset({ id: "char-su-user-locked-v1", name: "素", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const falsePanel = panel({
      id: "S1E01-U96-G1",
      index: 1,
      start: 0,
      end: 15,
      sourceText: "### G1\n| 构图 | 朴素的素色母版，采用鱼眼镜头与朔风意象 |",
      fields: { 构图: "朴素的素色母版，采用鱼眼镜头与朔风意象", 动作: "无角色" },
    });
    expect(duduReferencePresenceForPanel(falsePanel, su)).toBe("forbidden");
    const falseFixture = unitFixture({
      panels: [falsePanel, { ...falsePanel, id: "S1E01-U96-G2", index: 2, sourceStartOffsetUtf16: 1_000, sourceEndOffsetUtf16: 1_000 + falsePanel.sourceText.length }],
      visualExecutionPanels: [falsePanel, { ...falsePanel, id: "S1E01-U96-G2", index: 2, sourceStartOffsetUtf16: 1_000, sourceEndOffsetUtf16: 1_000 + falsePanel.sourceText.length }],
      references: [su],
      forbiddenReferences: [],
      binding: {
        format: "v2",
        file: unitFixture().binding!.file,
        body: [
          "## A. 权威与边界",
          "保持朴素的素色母版。",
          "## D. 逐格导演谱",
          "### S1E01-U96-G1",
          "使用朔风意象与鱼眼镜头。",
          "### S1E01-U96-G2",
          "沿用母题构图。",
          "## E. raw宫格中文提示词",
          "生成两格无角色环境板。",
        ].join("\n"),
        rawGridPrompt: "生成两格无角色环境板。",
        lifecycle: "FROZEN_READY",
        version: "v2.1",
        attemptBudget: 2,
      },
    });
    expect(() => auditDuduReadonlyUnitProjection(falseFixture)).toThrow(/未给参考 char-su-user-locked-v1 提供逐格可见或连续性证据/u);
  });

  it("removes administrative A paths, rejects any E/final prompt path, and never leaks local media locations", () => {
    const fixture = unitFixture();
    const safeRaw = "生成两格电影写实宫格，画面内无文字。";
    fixture.binding = {
      format: "v2",
      file: fixture.binding!.file,
      body: [
        "## A. 权威与边界",
        "来源：/Users/example/refs/identity.png",
        "- file:///private/tmp/identity.png",
        "- C:\\\\refs\\\\identity.png",
        "- refs/identity.png",
        "- 只允许当前批准身份与场景。",
        "## C. 身份规则",
        "嘟嘟与石穴树根保持批准外观。",
        "## D. 逐格导演谱",
        "### S1E01-U99-G1",
        "嘟嘟在石穴树根旁，电影写实。",
        "### S1E01-U99-G2",
        "纯黑独立成格。",
        "## E. raw宫格中文提示词",
        safeRaw,
        "## G. 硬失败",
        "身份漂移为硬失败。",
      ].join("\n"),
      rawGridPrompt: safeRaw,
      lifecycle: "FROZEN_READY",
      version: "v2.1",
      attemptBudget: 2,
    };
    const audit = auditDuduReadonlyUnitProjection(fixture);
    for (const body of Object.values(audit.promptBodyByPanelId)) {
      expect(body).not.toMatch(/\/Users|file:\/\/|\/private|\/tmp|[A-Za-z]:[\\/]|refs\/identity\.png/u);
    }

    for (const unsafeRaw of [
      "读取 /Users/example/refs/identity.png 后生成。",
      "读取 file:///private/tmp/identity.png 后生成。",
      "读取 /tmp/identity.png 后生成。",
      "读取 C:\\\\refs\\\\identity.png 后生成。",
      "读取 refs/identity.png 后生成。",
    ]) {
      const unsafe = { ...fixture, binding: { ...fixture.binding!, rawGridPrompt: unsafeRaw } };
      expect(() => auditDuduReadonlyUnitProjection(unsafe), unsafeRaw).toThrow(/路径|URL/u);
    }
  });

  it("相对媒体路径检测不因 !/ 重复回退，且仍拦截 refs/file.png", () => {
    expect(() => assertDuduPromptTextPathFree("refs/identity.png", "probe")).toThrow(/相对媒体路径/u);
    expect(() => assertDuduPromptTextPathFree("./foo/bar.jpg", "probe")).toThrow(/相对媒体路径/u);
    expect(() => assertDuduPromptTextPathFree("无路径的正常提示词", "probe")).not.toThrow();
    const noisy = `${"!/".repeat(4_000)} end`;
    const started = Date.now();
    expect(() => assertDuduPromptTextPathFree(noisy, "probe")).not.toThrow();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("does not use a generic empty nest as a mother/cub forbidden anchor", () => {
    const shuo = asset({ id: "char-shuo-user-locked-v1", name: "朔", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const su = asset({ id: "char-su-user-locked-v1", name: "素", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const dudu = asset({ id: "char-dudu-user-locked-v1", name: "嘟嘟", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const panels = [1, 2].map((index) => panel({
      id: `S1E01-U95-G${index}`,
      index,
      start: (index - 1) * 7.5,
      end: index * 7.5,
      sourceText: `### G${index}\n| 构图 | ${index === 1 ? "空窝与藤窝位于洞内" : "朔风掠过废弃草窝"} |`,
      fields: { 构图: index === 1 ? "空窝与藤窝位于洞内" : "废弃草窝", 动作: "无角色" },
    }));
    const body = [
      "## A. 权威与边界",
      "唯一角色是朔。",
      "## D. 逐格导演谱",
      "### S1E01-U95-G1",
      "展示空窝。",
      "### S1E01-U95-G2",
      "展示藤窝。",
      "## E. raw宫格中文提示词",
      "生成空窝与藤窝两格环境板，唯一角色是朔。",
    ].join("\n");
    expect(auditDuduV2BindingSafetyClosure({
      bindingBody: body,
      unitId: "S1E01-U95",
      panelCount: 2,
      panels,
      allowed: [shuo],
      registryAssets: [shuo, su, dudu],
    }).forbiddenReferences).toEqual([]);
  });

  it("fails closed on partial-only visibility and visible-vs-forbidden conflicts", () => {
    const shuo = asset({ id: "char-shuo-user-locked-v1", name: "朔", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const su = asset({ id: "char-su-user-locked-v1", name: "素", category: "character", sourceType: "character", referenceRole: "CHARACTER_IDENTITY" });
    const panels = [1, 2, 3].map((index) => panel({
      id: `S1E01-U97-G${index}`,
      index,
      start: (index - 1) * 5,
      end: index * 5,
      sourceText: `### S1E01-U97-G${index}\n| 构图 | ${index === 2 ? "素居画左全身" : "朔在洞口"} |`,
      fields: { 构图: index === 2 ? "素居画左全身" : "朔在洞口", 动作: "静止" },
    }));
    const body = (boundary: string) => [
      "## A. 权威与边界",
      boundary,
      "## D. 逐格导演谱",
      "### S1E01-U97-G1",
      "朔静守。",
      "### S1E01-U97-G2",
      "朔回头。",
      "### S1E01-U97-G3",
      "朔转回。",
      "## E. raw宫格中文提示词",
      "生成朔守夜三格。",
    ].join("\n");
    expect(() => auditDuduV2BindingSafetyClosure({
      bindingBody: body("不得让素完整入画。"),
      unitId: "S1E01-U97",
      panelCount: 3,
      panels: panels.map((entry) => ({ ...entry, fields: { 构图: "朔在洞口", 动作: "静止" } })),
      allowed: [shuo],
      registryAssets: [shuo, su],
    })).toThrow(/部分可见约束/u);
    expect(() => auditDuduV2BindingSafetyClosure({
      bindingBody: body("唯一角色是朔。"),
      unitId: "S1E01-U97",
      panelCount: 3,
      panels,
      allowed: [shuo],
      registryAssets: [shuo, su],
    })).toThrow(/同时被声明可见与 forbidden/u);
  });
});
