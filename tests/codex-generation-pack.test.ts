import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertCodexGenerationPackCurrent,
  buildAssetBindingSet,
  buildCodexGenerationPack,
  CodexGenerationPackValidationError,
  resolveExactMentions,
  type AssetBindingSet,
  type AssetBindingSource,
  type BuildCodexGenerationPackInput,
  type CodexGenerationPackErrorCode,
  type ContinuitySnapshot,
  type MentionResolvableAsset,
  type ScriptMention,
  type ScriptMentionInput,
} from "../src/core/codex-generation-pack.js";

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SCRIPT_SHA = sha("剧本-v7");
const C01_SHA = sha("阿航权威图-v3");
const S01_SHA = sha("封神榜缝权威图-v2");
const P01_SHA = sha("黄金面具权威图-v4");

const resolvableAssets: MentionResolvableAsset[] = [
  { canonicalAssetId: "C01", category: "character", canonicalName: "阿航", aliases: ["青年阿航", "男主"] },
  { canonicalAssetId: "S01", category: "scene", canonicalName: "封神榜缝", aliases: ["榜缝"] },
  { canonicalAssetId: "P01", category: "prop", canonicalName: "完整黄金面具", aliases: ["黄金面具", "面具本体"] },
];

function mention(
  id: string,
  text: string,
  presence: "required" | "optional" | "forbidden" = "required",
  role = "主体",
  startOffset = 0,
): ScriptMentionInput {
  return {
    id,
    text,
    presence,
    role,
    source: {
      documentId: "script-ep01",
      documentRevision: 7,
      documentSha256: SCRIPT_SHA,
      startOffset,
      endOffset: startOffset + text.length,
    },
  };
}

function bindingSource(
  canonicalAssetId: string,
  category: "character" | "scene" | "prop",
  mediaSha256: string,
  patch: Partial<AssetBindingSource> = {},
): AssetBindingSource {
  return {
    canonicalAssetId,
    category,
    definitionVersionId: `definition-${canonicalAssetId}-v1`,
    authority: { id: `authority-${canonicalAssetId}-v1`, status: "approved", isCurrent: true, exposure: "allowed" },
    assetVersion: { id: `asset-version-${canonicalAssetId}-v1`, status: "approved", isCurrent: true },
    mediaSha256,
    ...patch,
  };
}

function basicMentions(): ScriptMention[] {
  return resolveExactMentions({
    mentions: [
      mention("m-c01", "青年阿航", "required", "主角", 0),
      mention("m-s01", "S01", "required", "主场景", 10),
      mention("m-p01", "黄金面具", "forbidden", "布囊内隐藏身份", 20),
    ],
    assets: resolvableAssets,
  });
}

function basicBindingSet(): AssetBindingSet {
  return buildAssetBindingSet({
    projectId: "project-codex-drama",
    mentions: basicMentions(),
    assets: [
      bindingSource("C01", "character", C01_SHA),
      bindingSource("S01", "scene", S01_SHA),
      bindingSource("P01", "prop", P01_SHA, {
        authority: { id: "authority-P01-v1", status: "approved", isCurrent: true, exposure: "forbidden" },
      }),
    ],
  });
}

function continuityFor(bindingSet: AssetBindingSet): ContinuitySnapshot[] {
  return bindingSet.bindings.map((binding): ContinuitySnapshot => {
    const assetState: ContinuitySnapshot["assetState"] = binding.canonicalAssetId === "C01"
      ? { face: "权威同脸", costume: "黑衣", hair: "发髻与左侧银白挑染" }
      : binding.canonicalAssetId === "P01"
        ? { visibility: "布囊内部，画面不可见", structure: "完整面具" }
        : { layout: "榜缝空间布局锁定" };
    return {
      canonicalAssetId: binding.canonicalAssetId,
      category: binding.category,
      definitionVersionId: binding.definitionVersionId,
      authorityId: binding.authorityId,
      assetVersionId: binding.assetVersionId,
      mediaSha256: binding.mediaSha256,
      status: "resolved",
      assetState,
      evidence: [{ kind: "asset-version", id: binding.assetVersionId, sha256: binding.mediaSha256 }],
    };
  });
}

function prompt(text = "电影写实，阿航站在封神榜缝前，黑衣与银白挑染保持一致；黄金面具藏在布囊内且不可见。"): { text: string; sha256: string } {
  return { text, sha256: sha(text) };
}

function packInput(
  patch: Partial<BuildCodexGenerationPackInput> = {},
): BuildCodexGenerationPackInput {
  const bindingSet = basicBindingSet();
  return {
    projectId: "project-codex-drama",
    bindingSet,
    continuitySnapshots: continuityFor(bindingSet),
    promptArtifact: prompt(),
    target: {
      itemId: "EP01_15s_001-panel-1",
      mode: "storyboard-panel",
      panelIndex: 1,
      panelCount: 2,
      durationSeconds: 7.5,
      totalDurationSeconds: 15,
    },
    controlReferences: [
      { canonicalAssetId: "C01", path: "/project/assets/C01/raw.png", sha256: C01_SHA },
      { canonicalAssetId: "S01", path: "/project/assets/S01/raw.png", sha256: S01_SHA },
      { canonicalAssetId: "P01", path: "/project/assets/P01/raw.png", sha256: P01_SHA },
    ],
    ...patch,
  };
}

function expectCode(action: () => unknown, code: CodexGenerationPackErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CodexGenerationPackValidationError);
    expect((error as CodexGenerationPackValidationError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但调用成功。`);
}

describe("Codex imagegen 一致性包", () => {
  it("只按正式 ID、正式名或 alias 完整匹配，重复 alias 保留歧义且不静默选中", () => {
    const result = resolveExactMentions({
      mentions: [
        mention("id", "c01", "required", "主角", 0),
        mention("name", " 阿航 ", "required", "主角", 10),
        mention("alias", "青年阿航", "required", "主角", 20),
        mention("not-fuzzy", "青年阿", "optional", "候选", 30),
        { ...mention("excluded", "路人", "required", "排除", 40), excluded: true },
        mention("ambiguous", "守门人", "required", "人物", 50),
      ],
      assets: [
        ...resolvableAssets,
        { canonicalAssetId: "C02", category: "character", canonicalName: "甲", aliases: ["守门人"] },
        { canonicalAssetId: "C03", category: "character", canonicalName: "乙", aliases: ["守门人"] },
      ],
    });

    expect(result.slice(0, 3).map((entry) => [entry.status, entry.selected?.matchKind])).toEqual([
      ["matched", "id"],
      ["matched", "formal-name"],
      ["matched", "alias"],
    ]);
    expect(result[3]).toMatchObject({ status: "unmatched", candidates: [] });
    expect(result[4]).toMatchObject({ status: "excluded", candidates: [] });
    expect(result[5]?.status).toBe("ambiguous");
    expect(result[5]?.selected).toBeUndefined();
    expect(result[5]?.candidates.map((candidate) => candidate.canonicalAssetId)).toEqual(["C02", "C03"]);
    expect(result[0]?.source.offsetEncoding).toBe("utf16-code-unit-v1");
    expect(result.slice(0, 3).every((entry) => entry.resolution?.kind === "exact" && entry.resolution.receiptId.startsWith("exact-"))).toBe(true);
  });

  it("全局层级为 exact ID > formal name > alias，低层命中不得制造假歧义", () => {
    const idWins = resolveExactMentions({
      mentions: [mention("id-wins", "c01")],
      assets: [
        { canonicalAssetId: "C01", category: "character", canonicalName: "阿航", aliases: [] },
        { canonicalAssetId: "C99", category: "character", canonicalName: "假身份", aliases: ["C01"] },
      ],
    })[0]!;
    expect(idWins).toMatchObject({
      status: "matched",
      selected: { canonicalAssetId: "C01", matchKind: "id" },
    });
    expect(idWins.candidates).toHaveLength(1);

    const formalNameWins = resolveExactMentions({
      mentions: [mention("formal-wins", "阿航")],
      assets: [
        { canonicalAssetId: "C01", category: "character", canonicalName: "阿航", aliases: [] },
        { canonicalAssetId: "C99", category: "character", canonicalName: "假身份", aliases: ["阿航"] },
      ],
    })[0]!;
    expect(formalNameWins).toMatchObject({
      status: "matched",
      selected: { canonicalAssetId: "C01", matchKind: "formal-name" },
    });
    expect(formalNameWins.candidates).toHaveLength(1);
  });

  it("同一全局层命中多个资产时必须 ambiguous，不按 ID 静默选中", () => {
    const [result] = resolveExactMentions({
      mentions: [mention("same-tier", "巡守")],
      assets: [
        { canonicalAssetId: "C02", category: "character", canonicalName: "巡守", aliases: [] },
        { canonicalAssetId: "C03", category: "character", canonicalName: "巡守", aliases: [] },
      ],
    });
    expect(result).toMatchObject({ status: "ambiguous" });
    expect(result?.selected).toBeUndefined();
    expect(result?.resolution).toBeUndefined();
    expect(result?.candidates.map((candidate) => candidate.canonicalAssetId)).toEqual(["C02", "C03"]);
  });

  it("必需提及 ambiguous/unmatched 时失败关闭", () => {
    const mentions = resolveExactMentions({
      mentions: [mention("missing", "不存在的人物")],
      assets: resolvableAssets,
    });
    expectCode(() => buildAssetBindingSet({ projectId: "p", mentions, assets: [] }), "required-mention-unresolved");

    const ambiguous = resolveExactMentions({
      mentions: [mention("ambiguous", "守门人")],
      assets: [
        { canonicalAssetId: "C02", category: "character", canonicalName: "甲", aliases: ["守门人"] },
        { canonicalAssetId: "C03", category: "character", canonicalName: "乙", aliases: ["守门人"] },
      ],
    });
    expectCode(() => buildAssetBindingSet({ projectId: "p", mentions: ambiguous, assets: [] }), "required-mention-unresolved");
  });

  it("forbidden 提及 ambiguous/unmatched 也失败关闭，不得静默丢失禁止约束", () => {
    const unmatched = resolveExactMentions({
      mentions: [mention("hidden-mask", "完整黄金面具", "forbidden", "画面不得露出")],
      assets: [],
    });
    expectCode(
      () => buildAssetBindingSet({ projectId: "p", mentions: unmatched, assets: [] }),
      "required-mention-unresolved",
    );

    const ambiguous = resolveExactMentions({
      mentions: [mention("ambiguous-mask", "面具", "forbidden", "画面不得露出")],
      assets: [
        { canonicalAssetId: "P01", category: "prop", canonicalName: "完整黄金面具", aliases: ["面具"] },
        { canonicalAssetId: "P02", category: "prop", canonicalName: "半面具", aliases: ["面具"] },
      ],
    });
    expectCode(
      () => buildAssetBindingSet({ projectId: "p", mentions: ambiguous, assets: [] }),
      "required-mention-unresolved",
    );
  });

  it("模型 suggestion 最多五项且只供审核，没有 exact 命中时不得自动 matched", () => {
    const suggestion = {
      canonicalAssetId: "C01",
      category: "character" as const,
      canonicalName: "阿航",
      matchKind: "manual" as const,
      matchedValue: "上文中的他",
    };
    const [result] = resolveExactMentions({
      mentions: [{ ...mention("pronoun", "他", "optional", "待审指代"), suggestions: [suggestion] }],
      assets: resolvableAssets,
    });
    expect(result).toMatchObject({
      status: "unmatched",
      candidates: [],
      suggestions: [suggestion],
    });
    expect(result?.selected).toBeUndefined();
    expect(result?.resolution).toBeUndefined();

    expectCode(() => resolveExactMentions({
      mentions: [{
        ...mention("too-many", "他", "optional"),
        suggestions: Array.from({ length: 6 }, (_, index) => ({
          canonicalAssetId: `C${index + 1}`,
          category: "character" as const,
          canonicalName: `人物${index + 1}`,
          matchKind: "manual" as const,
          matchedValue: "他",
        })),
      }],
      assets: [],
    }), "invalid-input");
  });

  it("人工 select/exclude 以 receipt 形成可哈希 ScriptMention，非法状态组合失败关闭", () => {
    const manualCandidate = {
      canonicalAssetId: "C01",
      category: "character" as const,
      canonicalName: "阿航",
      matchKind: "manual" as const,
      matchedValue: "他",
    };
    const proposal = resolveExactMentions({
      mentions: [{ ...mention("manual", "他", "optional", "上文主角"), suggestions: [manualCandidate] }],
      assets: resolvableAssets,
    })[0]!;
    const selected: ScriptMention = {
      ...proposal,
      status: "matched",
      candidates: [manualCandidate],
      selected: manualCandidate,
      resolution: { kind: "human-select", receiptId: "review-receipt-select-001" },
    };
    const selectedBinding = buildAssetBindingSet({
      projectId: "p-human",
      mentions: [selected],
      assets: [bindingSource("C01", "character", C01_SHA)],
    });
    expect(selectedBinding.mentions[0]).toMatchObject({
      status: "matched",
      source: { offsetEncoding: "utf16-code-unit-v1" },
      selected: { canonicalAssetId: "C01", matchKind: "manual" },
      resolution: { kind: "human-select", receiptId: "review-receipt-select-001" },
    });
    expect(selectedBinding.bindings.map((binding) => binding.canonicalAssetId)).toEqual(["C01"]);

    const excluded: ScriptMention = {
      ...proposal,
      status: "excluded",
      candidates: [],
      resolution: { kind: "human-exclude", receiptId: "review-receipt-exclude-001" },
    };
    const excludedBinding = buildAssetBindingSet({ projectId: "p-human", mentions: [excluded], assets: [] });
    expect(excludedBinding.mentions[0]).toMatchObject({
      status: "excluded",
      resolution: { kind: "human-exclude", receiptId: "review-receipt-exclude-001" },
    });
    expect(excludedBinding.bindings).toEqual([]);
    expect(excludedBinding.fingerprint).not.toBe(selectedBinding.fingerprint);

    const invalidHumanSelect: ScriptMention = {
      ...proposal,
      resolution: { kind: "human-select", receiptId: "wrong-state" },
    };
    expectCode(
      () => buildAssetBindingSet({ projectId: "p-human", mentions: [invalidHumanSelect], assets: [] }),
      "invalid-input",
    );
    const missingReceiptKind: ScriptMention = {
      ...selected,
      resolution: undefined,
    };
    expectCode(
      () => buildAssetBindingSet({ projectId: "p-human", mentions: [missingReceiptKind], assets: [bindingSource("C01", "character", C01_SHA)] }),
      "invalid-input",
    );
    const invalidHumanExclude: ScriptMention = {
      ...selected,
      resolution: { kind: "human-exclude", receiptId: "wrong-state" },
    };
    expectCode(
      () => buildAssetBindingSet({ projectId: "p-human", mentions: [invalidHumanExclude], assets: [bindingSource("C01", "character", C01_SHA)] }),
      "invalid-input",
    );
  });

  it("绑定集冻结剧本 revision/SHA 与每项资产的定义、Authority、Version、媒体 SHA", () => {
    const bindingSet = basicBindingSet();
    expect(bindingSet.scriptDocuments).toEqual([{ documentId: "script-ep01", revision: 7, sha256: SCRIPT_SHA }]);
    expect(bindingSet.bindings).toHaveLength(3);
    expect(bindingSet.bindings[0]).toEqual(expect.objectContaining({
      canonicalAssetId: "C01",
      category: "character",
      definitionVersionId: "definition-C01-v1",
      authorityId: "authority-C01-v1",
      assetVersionId: "asset-version-C01-v1",
      mediaSha256: C01_SHA,
      presence: "required",
      role: "主角",
      mentionIds: ["m-c01"],
    }));
    expect(bindingSet.id).toContain(bindingSet.fingerprint.slice(0, 32));
  });

  it("required binding 缺少 approved/current Authority 或 Version 时拒绝", () => {
    const mentions = resolveExactMentions({ mentions: [mention("m", "阿航")], assets: resolvableAssets });
    const pending = bindingSource("C01", "character", C01_SHA, {
      authority: { id: "authority-C01-v1", status: "pending", isCurrent: true, exposure: "allowed" },
    });
    expectCode(
      () => buildAssetBindingSet({ projectId: "p", mentions, assets: [pending] }),
      "required-binding-not-ready",
    );
    const stale = bindingSource("C01", "character", C01_SHA, {
      assetVersion: { id: "asset-version-C01-v1", status: "approved", isCurrent: false },
    });
    expectCode(
      () => buildAssetBindingSet({ projectId: "p", mentions, assets: [stale] }),
      "required-binding-not-ready",
    );
  });

  it("构建两格中文故事图包：固定一次一图、串行，hidden/forbidden 不进入控制参考", () => {
    const input = packInput();
    const pack = buildCodexGenerationPack(input);

    expect(pack).toMatchObject({
      executorKind: "codex-imagegen",
      exactlyOneImage: true,
      maxCalls: 1,
      sequentialOnly: true,
      target: { mode: "storyboard-panel", panelIndex: 1, panelCount: 2, totalDurationSeconds: 15 },
    });
    expect(pack.promptArtifact.text).toContain("阿航站在封神榜缝前");
    expect(pack.controlReferences.map((reference) => reference.canonicalAssetId)).toEqual(["C01", "S01"]);
    expect(pack.safeModelPayload.references.map((reference) => reference.canonicalAssetId)).toEqual(["C01", "S01"]);
    expect(pack.safeModelPayload.forbiddenAssets).toEqual([{ canonicalAssetId: "P01", category: "prop", role: "布囊内隐藏身份" }]);
    expect(JSON.stringify(pack.safeModelPayload)).not.toContain("/project/");
    expect(JSON.stringify(pack.safeModelPayload)).not.toContain("file://");
    expect(pack.controlReferences.every((reference) => reference.path.startsWith("/project/"))).toBe(true);
    expect(assertCodexGenerationPackCurrent({ pack, snapshots: input })).toBe(pack);
  });

  it("允许六格且总时长精确为 15 秒，也支持单图目标", () => {
    const six = buildCodexGenerationPack(packInput({
      target: {
        itemId: "EP01_15s_008-panel-6",
        mode: "storyboard-panel",
        panelIndex: 6,
        panelCount: 6,
        durationSeconds: 2.5,
        totalDurationSeconds: 15,
      },
    }));
    expect(six.target).toMatchObject({ panelIndex: 6, panelCount: 6, totalDurationSeconds: 15 });

    const single = buildCodexGenerationPack(packInput({
      target: {
        itemId: "character-C01-authority",
        mode: "single",
        panelIndex: 1,
        panelCount: 1,
        durationSeconds: 1,
        totalDurationSeconds: 1,
      },
    }));
    expect(single.target.mode).toBe("single");
  });

  it("超过六项参考要求先建立组合派生资产", () => {
    const assets: MentionResolvableAsset[] = Array.from({ length: 7 }, (_, index) => ({
      canonicalAssetId: `C${index + 1}`,
      category: "character" as const,
      canonicalName: `角色${index + 1}`,
      aliases: [],
    }));
    const mentions = resolveExactMentions({
      mentions: assets.map((asset, index) => mention(`m-${index + 1}`, asset.canonicalName, "required", `人物${index + 1}`, index * 10)),
      assets,
    });
    const sources = assets.map((asset) => bindingSource(asset.canonicalAssetId, "character", sha(`media-${asset.canonicalAssetId}`)));
    const bindingSet = buildAssetBindingSet({ projectId: "p-seven", mentions, assets: sources });
    const input: BuildCodexGenerationPackInput = {
      projectId: "p-seven",
      bindingSet,
      continuitySnapshots: continuityFor(bindingSet),
      promptArtifact: prompt("七名角色在同一古蜀场景中，保持各自锁定外观。"),
      target: { itemId: "panel", mode: "storyboard-panel", panelIndex: 1, panelCount: 2, durationSeconds: 7.5, totalDurationSeconds: 15 },
      controlReferences: bindingSet.bindings.map((binding) => ({
        canonicalAssetId: binding.canonicalAssetId,
        path: `/project/assets/${binding.canonicalAssetId}.png`,
        sha256: binding.mediaSha256,
      })),
    };
    expectCode(() => buildCodexGenerationPack(input), "too-many-references");
  });

  it("拒绝超过 15 秒、非法格数、提示词 SHA 不符与模型面路径", () => {
    expectCode(() => buildCodexGenerationPack(packInput({
      target: { itemId: "bad", mode: "storyboard-panel", panelIndex: 1, panelCount: 2, durationSeconds: 8, totalDurationSeconds: 15.001 },
    })), "target-invalid");
    expectCode(() => buildCodexGenerationPack(packInput({
      target: { itemId: "bad", mode: "storyboard-panel", panelIndex: 1, panelCount: 7, durationSeconds: 2, totalDurationSeconds: 14 },
    })), "target-invalid");
    expectCode(() => buildCodexGenerationPack(packInput({
      promptArtifact: { text: "正文已变", sha256: sha("旧正文") },
    })), "prompt-sha-mismatch");
    expectCode(() => buildCodexGenerationPack(packInput({
      promptArtifact: prompt("读取 /Users/test/reference.png 后生成古蜀场景。"),
    })), "unsafe-model-payload");
    expectCode(() => buildCodexGenerationPack(packInput({
      promptArtifact: prompt("改用 GPT Image 2，并准备 provider fallback。"),
    })), "unsafe-model-payload");
  });

  it("continuity unresolved/conflicted 或绑定版本不一致时失败关闭", () => {
    const base = packInput();
    const unresolved = structuredClone(base.continuitySnapshots);
    unresolved[0]!.status = "unresolved";
    expectCode(() => buildCodexGenerationPack({ ...base, continuitySnapshots: unresolved }), "continuity-not-resolved");

    const conflicted = structuredClone(base.continuitySnapshots);
    conflicted[1]!.status = "conflicted";
    expectCode(() => buildCodexGenerationPack({ ...base, continuitySnapshots: conflicted }), "continuity-not-resolved");

    const versionDrift = structuredClone(base.continuitySnapshots);
    versionDrift[0]!.assetVersionId = "asset-version-C01-v2";
    expectCode(() => buildCodexGenerationPack({ ...base, continuitySnapshots: versionDrift }), "input-drift");
  });

  it("脚本、SHA、资产版本、提示词或连续性任一当前输入漂移都会拒绝旧包", () => {
    const originalInput = packInput();
    const pack = buildCodexGenerationPack(originalInput);

    const scriptDriftBinding = buildAssetBindingSet({
      projectId: originalInput.projectId,
      mentions: basicMentions().map((entry) => ({
        ...entry,
        source: { ...entry.source, documentRevision: 8, documentSha256: sha("剧本-v8") },
      })),
      assets: [
        bindingSource("C01", "character", C01_SHA),
        bindingSource("S01", "scene", S01_SHA),
        bindingSource("P01", "prop", P01_SHA, {
          authority: { id: "authority-P01-v1", status: "approved", isCurrent: true, exposure: "forbidden" },
        }),
      ],
    });
    expectCode(() => assertCodexGenerationPackCurrent({
      pack,
      snapshots: { ...originalInput, bindingSet: scriptDriftBinding, continuitySnapshots: continuityFor(scriptDriftBinding) },
    }), "input-drift");

    const changedSources = [
      bindingSource("C01", "character", sha("阿航权威图-v4"), {
        assetVersion: { id: "asset-version-C01-v2", status: "approved", isCurrent: true },
      }),
      bindingSource("S01", "scene", S01_SHA),
      bindingSource("P01", "prop", P01_SHA, {
        authority: { id: "authority-P01-v1", status: "approved", isCurrent: true, exposure: "forbidden" },
      }),
    ];
    const assetDriftBinding = buildAssetBindingSet({ projectId: originalInput.projectId, mentions: basicMentions(), assets: changedSources });
    expectCode(() => assertCodexGenerationPackCurrent({
      pack,
      snapshots: {
        ...originalInput,
        bindingSet: assetDriftBinding,
        continuitySnapshots: continuityFor(assetDriftBinding),
        controlReferences: originalInput.controlReferences.map((reference) => reference.canonicalAssetId === "C01"
          ? { ...reference, sha256: sha("阿航权威图-v4") }
          : reference),
      },
    }), "input-drift");

    const changedPrompt = prompt("同一镜头改为阿航回头，但仍保持锁定脸与服装。 ".trim());
    expectCode(() => assertCodexGenerationPackCurrent({
      pack,
      snapshots: { ...originalInput, promptArtifact: changedPrompt },
    }), "input-drift");

    const continuityDrift = structuredClone(originalInput.continuitySnapshots);
    continuityDrift[0]!.assetState.costume = "灰褐衣";
    expectCode(() => assertCodexGenerationPackCurrent({
      pack,
      snapshots: { ...originalInput, continuitySnapshots: continuityDrift },
    }), "input-drift");
  });

  it("输入数组顺序不影响绑定集与生图包稳定指纹", () => {
    const mentions = basicMentions();
    const sources = [
      bindingSource("C01", "character", C01_SHA),
      bindingSource("S01", "scene", S01_SHA),
      bindingSource("P01", "prop", P01_SHA, {
        authority: { id: "authority-P01-v1", status: "approved", isCurrent: true, exposure: "forbidden" },
      }),
    ];
    const firstBinding = buildAssetBindingSet({ projectId: "project-codex-drama", mentions, assets: sources });
    const secondBinding = buildAssetBindingSet({ projectId: "project-codex-drama", mentions: [...mentions].reverse(), assets: [...sources].reverse() });
    expect(secondBinding.fingerprint).toBe(firstBinding.fingerprint);
    expect(secondBinding.id).toBe(firstBinding.id);

    const firstInput = packInput({ bindingSet: firstBinding, continuitySnapshots: continuityFor(firstBinding) });
    const secondInput: BuildCodexGenerationPackInput = {
      ...firstInput,
      bindingSet: secondBinding,
      continuitySnapshots: [...continuityFor(secondBinding)].reverse(),
      controlReferences: [...firstInput.controlReferences].reverse(),
    };
    const firstPack = buildCodexGenerationPack(firstInput);
    const secondPack = buildCodexGenerationPack(secondInput);
    expect(secondPack.inputSnapshotFingerprint).toBe(firstPack.inputSnapshotFingerprint);
    expect(secondPack.fingerprint).toBe(firstPack.fingerprint);
    expect(secondPack.id).toBe(firstPack.id);
  });
});
