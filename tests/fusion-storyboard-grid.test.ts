import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFusionStoryboardGrid,
  FusionStoryboardGridValidationError,
  type FusionStoryboardGridContract,
  type FusionStoryboardGridBuildInput,
} from "../src/core/fusion-storyboard-grid.js";
import { loadFusionPanelReferenceStore } from "../src/core/fusion-panel-references.js";
import type { FusionScheduleRow } from "../src/core/fusion-package.js";
import { getSidecarPaths, readJson } from "../src/core/sidecar.js";
import type { FusionStoryboardGridSelectionStore, StoryboardProductionContract } from "../src/core/types.js";

const UNIT_ID = "season-3-ep01-unit001";

function rows(durations: number[]): StoryboardProductionContract[] {
  return durations.map((durationSeconds, index) => ({
    storyboardRowId: `row-${index + 1}`,
    storyboardRowRevision: index + 1,
    itemId: UNIT_ID,
    shotItemId: `${UNIT_ID}-shot${index + 1}`,
    order: index + 1,
    durationSeconds,
    shotSize: index === 0 ? "远景" : index === durations.length - 1 ? "特写" : "中景",
    cameraMovement: index % 2 === 0 ? "缓慢推进" : "固定镜头",
    cameraAngle: "平视",
    lens: "50mm",
    composition: "主体居中，保留纵深",
    staging: "人物沿中轴线行动",
    action: `剧情动作 ${index + 1}`,
    expression: "警觉",
    emotion: index === durations.length - 1 ? "决断" : "紧张",
    dialogue: index % 2 === 0 ? `台词 ${index + 1}` : undefined,
    narration: index % 2 === 1 ? `旁白 ${index + 1}` : undefined,
    ambience: "风声",
    soundEffects: ["脚步声"],
    continuityBefore: index ? `承接 row-${index}` : "承接上集",
    continuityAfter: index === durations.length - 1 ? "落在悬念" : `进入 row-${index + 2}`,
    firstFramePrompt: `第 ${index + 1} 段起势画面`,
    endFramePrompt: `第 ${index + 1} 段落点画面`,
    videoPrompt: `第 ${index + 1} 段动作连续`,
    referencePaths: [],
    referenceArtifactIds: [],
  }));
}

function schedule(durations: number[]): FusionScheduleRow[] {
  let cursor = 0;
  return durations.map((durationSeconds, index) => {
    const startSeconds = cursor;
    cursor = index === durations.length - 1 ? 15 : Math.round((cursor + durationSeconds) * 1_000) / 1_000;
    return {
      index,
      startSeconds,
      endSeconds: cursor,
      durationSeconds: Math.round((cursor - startSeconds) * 1_000) / 1_000,
      label: `镜${index + 1}`,
      content: `排期剧情 ${index + 1}`,
      kind: "source-shot",
      sourceShotNumber: index + 1,
    };
  });
}

function input(durations: number[], patch: Partial<FusionStoryboardGridBuildInput> = {}): FusionStoryboardGridBuildInput {
  return {
    unit: {
      unitId: UNIT_ID,
      title: "承第二季彩蛋",
      episodeLabel: "EP01",
      unitSequence: 1,
      storyGoal: "封神榜缝隙开启",
      aspectRatio: "9:16",
      standardDurationSeconds: 15,
    },
    storyboardRevision: 7,
    rows: rows(durations),
    schedule: schedule(durations),
    ...patch,
  };
}

describe("15 秒融合宫格分镜合同", () => {
  it("单剧情段自动拆为起势/落点两格，并输出可本地排版的中文故事板模型", () => {
    const contract = buildFusionStoryboardGrid(input([15], {
      assetIdsByRowId: { "row-1": ["C01", "S01", "P01"] },
    }));
    expect(contract.selection).toMatchObject({ mode: "automatic", panelCount: 2, sourceRowCount: 1 });
    expect(contract.displayTiming).toEqual({ policyVersion: "one-decimal-boundaries-then-difference-v1", decimals: 1, durationDerivedFromDisplayedBoundaries: true, totalVisibleDurationSeconds: 15 });
    expect(contract.panels.map((panel) => panel.frameRole)).toEqual(["start", "end"]);
    expect(contract.panels.map((panel) => [panel.startSeconds, panel.endSeconds])).toEqual([[0, 7.5], [7.5, 15]]);
    expect(contract.panels[0]?.imageGenerationPrompt).toContain("第 1 段起势画面");
    expect(contract.panels[1]?.imageGenerationPrompt).toContain("第 1 段落点画面");
    expect(contract.panels.every((panel) => panel.imageGenerationPrompt.includes("画面内不要任何中文"))).toBe(true);
    expect(contract.panels.every((panel) => panel.storyboardRowIds[0] === "row-1")).toBe(true);
    expect(contract.panels.every((panel) => panel.assetIds.join(",") === "C01,P01,S01")).toBe(true);
    expect(contract.panels[0]?.tableFields.map((field) => field.label)).toEqual([
      "画面内容/动作",
      "景别/构图",
      "拍摄方式",
      "连续性/声音",
      "台词/字幕",
      "时长",
    ]);
    expect(contract.header.title).toBe("15秒分镜故事板·承第二季彩蛋");
    expect(contract.footer.rhythmChain).toHaveLength(2);
    expect(contract.localRendering).toMatchObject({
      engine: "svg-sharp",
      language: "zh-CN",
      textRendering: "local-only",
      panelImageMode: "one-image-per-panel",
      assetReferenceMode: "one-image-per-asset",
      aiImageContainsText: false,
    });
    expect(contract.localRendering.outputInstructions.join(" ")).toContain("本地 SVG");
    expect(contract.layout).toMatchObject({ gridColumns: 1, gridRows: 2, panelCellModel: "image-left-details-columns" });
    expect(contract.panels.every((panel) => panel.layout.imagePlacement === "left" && panel.layout.detailPlacement === "right-table-columns")).toBe(true);
    expect(contract.coverage).toMatchObject({ allStoryboardRowsCovered: true, allScheduleRowsCovered: true });
  });

  it("按 EP01_15s_001 的真实剧情语义拆为四格，不把 12 秒主镜机械压成一格", () => {
    const semanticRows = rows([12, 3]);
    semanticRows[0] = {
      ...semanticRows[0]!,
      action: "极特写·贴榜横移。第一秒，封神榜三百六十五个名字同时亮起；第三秒，金文流到写不出字的空白格，整面榜顿住半息。金文绕开它继续流，格子深处一星黑金静悬，周围没有倒影。",
    };
    semanticRows[1] = {
      ...semanticRows[1]!,
      action: "补足动作前奏/反应/收束、运镜延展、环境声和道具细节；不新增改变剧情走向的事件。",
    };
    const contract = buildFusionStoryboardGrid(input([12, 3], { rows: semanticRows }));
    expect(contract.selection).toMatchObject({
      algorithmVersion: "semantic-beat-v1",
      panelCount: 4,
      detectedBeatCount: 4,
      cappedByMaximum: false,
    });
    expect(contract.selection.rowPlans.map((plan) => [plan.detectedBeatCount, plan.allocatedPanelCount])).toEqual([[3, 3], [1, 1]]);
    expect(contract.panels.map((panel) => panel.semanticBeats[0]?.text)).toEqual([
      "第一秒，封神榜三百六十五个名字同时亮起",
      "第三秒，金文流到写不出字的空白格，整面榜顿住半息",
      "金文绕开它继续流，格子深处一星黑金静悬，周围没有倒影",
      "补足动作前奏/反应/收束、运镜延展、环境声和道具细节；不新增改变剧情走向的事件",
    ]);
    expect(contract.panels.map((panel) => [panel.startSeconds, panel.endSeconds])).toEqual([[0, 3], [3, 7.5], [7.5, 12], [12, 15]]);
    expect(new Set(contract.panels.map((panel) => panel.imageGenerationPrompt)).size).toBe(4);
    expect(contract.panels.every((panel) => !panel.imageGenerationPrompt.includes("段内转折时刻"))).toBe(true);
  });

  it("按 EP01_15s_008 的人物和动作转折拆满六格，并把隐藏铁律并入对应动作而非伪造一格", () => {
    const semanticRows = rows([8, 5, 2]);
    semanticRows[0] = {
      ...semanticRows[0]!,
      action: "中景·侧移跟拍·胸前布囊。阿航一手按胸前布囊，内层贴身压着完整黄金面具，外侧小袋收着小鱼铜片，半璧另用素麻布包着。三件信物互不相露。布囊不发光，只随着呼吸轻轻一坠。嘟嘟忽然停步。",
    };
    semanticRows[1] = {
      ...semanticRows[1]!,
      action: "低机位·特写·嘟嘟认路。嘟嘟鼻尖贴着冻土，嗅到一缕极淡气息，尾巴僵住，随后猛地朝岔路小跑。阿航没有问，直接跟上。",
    };
    semanticRows[2] = {
      ...semanticRows[2]!,
      action: "补足动作前奏/反应/收束、运镜延展、环境声和道具细节；不新增改变剧情走向的事件。",
    };
    const contract = buildFusionStoryboardGrid(input([8, 5, 2], { rows: semanticRows }));
    expect(contract.selection.panelCount).toBe(6);
    expect(contract.selection.rowPlans.map((plan) => [plan.detectedBeatCount, plan.allocatedPanelCount])).toEqual([[2, 2], [3, 3], [1, 1]]);
    expect(contract.panels[0]?.imageContentAction).toContain("三件信物互不相露");
    expect(contract.panels[1]?.semanticBeats[0]?.text).toBe("嘟嘟忽然停步");
    expect(contract.panels[3]?.imageContentAction).toContain("朝岔路小跑");
    expect(contract.panels[4]?.semanticBeats[0]?.text).toBe("阿航没有问，直接跟上");
    expect(contract.panels.every((panel) => panel.semanticBeats.length >= 1)).toBe(true);
    expect(contract.panels.map((panel) => panel.durationLabel)).toEqual([
      "0.0–4.0s（4.0s）",
      "4.0–8.0s（4.0s）",
      "8.0–9.7s（1.7s）",
      "9.7–11.3s（1.6s）",
      "11.3–13.0s（1.7s）",
      "13.0–15.0s（2.0s）",
    ]);
    expect(contract.panels.reduce((sum, panel) => {
      const match = panel.durationLabel.match(/（([0-9.]+)s）$/u);
      return sum + Number(match?.[1] ?? Number.NaN);
    }, 0)).toBeCloseTo(15, 8);
  });

  it("可显式把本单元已出现资产补为后续连续性参考，并冻结不强行入画约束", () => {
    const semanticRows = rows([8, 5, 2]);
    semanticRows[0] = {
      ...semanticRows[0]!,
      action: "中景·侧移跟拍·胸前布囊。阿航一手按胸前布囊，三件信物互不相露。布囊不发光，只随着呼吸轻轻一坠。嘟嘟忽然停步。",
    };
    semanticRows[1] = {
      ...semanticRows[1]!,
      action: "低机位·特写·嘟嘟认路。嘟嘟鼻尖贴着冻土，尾巴僵住，随后猛地朝岔路小跑。阿航没有问，直接跟上。",
    };
    semanticRows[2] = {
      ...semanticRows[2]!,
      action: "补足动作前奏/反应/收束、运镜延展、环境声和道具细节；不新增改变剧情走向的事件。",
    };
    const contract = buildFusionStoryboardGrid(input([8, 5, 2], {
      rows: semanticRows,
      assetIdsByRowId: {
        "row-1": ["C01", "C02", "P01"],
        "row-2": ["C01", "C02"],
        "row-3": ["C01", "C02"],
      },
      referenceOverride: {
        expectedRevision: 7,
        reason: "P01 是阿航随身胸前布囊，必须跨格保持同一版本",
        promptInstruction: "P01 始终由 C01 随身携带；胸前进入画面时保持同一粗麻布囊，聚焦嘟嘟时可在画外，禁止露出内部物件或发光",
        additionalAssetIdsByRowId: {
          "row-2": ["P01"],
          "row-3": ["P01"],
        },
      },
    }));
    expect(contract.referenceOverride?.additionalAssetIdsByRowId).toEqual({ "row-2": ["P01"], "row-3": ["P01"] });
    expect(contract.panels.slice(0, 2).every((panel) => panel.continuityReferenceAssetIds.length === 0)).toBe(true);
    expect(contract.panels.slice(2).every((panel) => panel.continuityReferenceAssetIds.join(",") === "P01")).toBe(true);
    expect(contract.panels.slice(2).every((panel) => panel.assetIds.join(",") === "C01,C02,P01")).toBe(true);
    expect(contract.panels[2]?.imageGenerationPrompt).toContain("当前剧情和构图未明确展示时不得强行入画");
    expect(contract.panels[2]?.continuitySound).toContain("P01 始终由 C01 随身携带");
  });

  it("连续性参考不能注入本单元从未正式出现的资产", () => {
    expect(() => buildFusionStoryboardGrid(input([8, 5, 2], {
      assetIdsByRowId: { "row-1": ["C01"], "row-2": ["C01"], "row-3": ["C01"] },
      referenceOverride: {
        expectedRevision: 7,
        reason: "非法跨单元注入",
        promptInstruction: "不得注入",
        additionalAssetIdsByRowId: { "row-2": ["P99"] },
      },
    }))).toThrow(/只能复用本单元已正式出现的资产/u);
  });

  it.each([
    [2, [7, 8]],
    [3, [5, 5, 5]],
    [4, [3, 4, 4, 4]],
    [5, [3, 3, 3, 3, 3]],
    [6, [2.5, 2.5, 2.5, 2.5, 2.5, 2.5]],
  ] as const)("%i 个剧情段自动一段一格，不固定为六格", (count, durations) => {
    const contract = buildFusionStoryboardGrid(input([...durations]));
    expect(contract.panels).toHaveLength(count);
    expect(contract.selection.panelCount).toBe(count);
    expect(contract.panels.every((panel) => panel.storyboardRowIds.length === 1)).toBe(true);
    expect(contract.coverage.storyboardRowIds).toHaveLength(count);
    expect(contract.panels[0]?.frameRole).toBe("start");
    expect(contract.panels.at(-1)?.frameRole).toBe("end");
  });

  it("超过六段时透明归并为六格，所有 row 和 schedule 均保留覆盖证据", () => {
    const durations = [2, 2, 2, 2, 2, 2, 1.5, 1.5];
    const contract = buildFusionStoryboardGrid(input(durations));
    expect(contract.panels).toHaveLength(6);
    expect(contract.selection.reason).toContain("透明归并");
    expect(contract.coverage.storyboardRowIds).toEqual(rows(durations).map((row) => row.storyboardRowId));
    expect(contract.coverage.scheduleRowIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(contract.coverage.groupedPanelIds.length).toBeGreaterThan(0);
    expect(new Set(contract.panels.flatMap((panel) => panel.storyboardRowIds))).toEqual(new Set(rows(durations).map((row) => row.storyboardRowId)));
    expect(contract.panels.filter((panel) => panel.storyboardRowIds.length > 1).every((panel) => panel.selectionReason.includes("透明合并"))).toBe(true);
    expect(contract.panels.reduce((sum, panel) => sum + panel.durationSeconds, 0)).toBe(15);
  });

  it("显式 2–6 格 override 可拆分较长剧情段，但必须通过 storyboard 修订冲突门禁", () => {
    const contract = buildFusionStoryboardGrid(input([8, 7], {
      storyboardRevision: 11,
      override: { panelCount: 6, expectedRevision: 11, reason: "动作密集，需表现中间转折" },
    }));
    expect(contract.selection).toMatchObject({ mode: "explicit-override", panelCount: 6, overrideReason: "动作密集，需表现中间转折" });
    expect(contract.coverage.splitStoryboardRowIds.sort()).toEqual(["row-1", "row-2"]);
    expect(new Set(contract.panels.flatMap((panel) => panel.storyboardRowIds))).toEqual(new Set(["row-1", "row-2"]));
    expect(contract.panels[0]?.startSeconds).toBe(0);
    expect(contract.panels.at(-1)?.endSeconds).toBe(15);
    expect(contract.panels.every((panel, index) => index === 0 || panel.startSeconds === contract.panels[index - 1]?.endSeconds)).toBe(true);

    expect(() => buildFusionStoryboardGrid(input([8, 7], {
      storyboardRevision: 12,
      override: { panelCount: 4, expectedRevision: 11, reason: "过期覆盖" },
    }))).toThrowError(/storyboard 冲突/);
    expect(() => buildFusionStoryboardGrid(input([8, 7], {
      override: { panelCount: 7, expectedRevision: 7, reason: "超上限" },
    }))).toThrowError(/2–6/);
    expect(() => buildFusionStoryboardGrid(input([8, 7], {
      override: { panelCount: 4, expectedRevision: 7, reason: " " },
    }))).toThrowError(/必须记录原因/);
  });

  it("严格拒绝不满 15 秒或排期不连续的输入", () => {
    expect(() => buildFusionStoryboardGrid(input([7, 7], { schedule: schedule([7, 8]) }))).toThrowError(FusionStoryboardGridValidationError);
    const broken = schedule([7, 8]);
    broken[1] = { ...broken[1]!, startSeconds: 7.5, durationSeconds: 7.5 };
    expect(() => buildFusionStoryboardGrid(input([7, 8], { schedule: broken }))).toThrowError(/不连续/);
  });
});

const FORMAL_PROJECT_ROOT = path.resolve(process.env.AI_CANVAS_P2_REGRESSION_PROJECT_ROOT
  ?? "productions/gushujuan-s3-f1a688020bfb7af6");
const FORMAL_P01_HARD_LOCK_SHA256 = "907e96df267d3520c302ea2dad36afa5f6c42181f28492bd35a22450e5ad70a5";
const formalP2Regression = existsSync(getSidecarPaths(FORMAL_PROJECT_ROOT).panelReferenceResolutions) ? it : it.skip;

formalP2Regression("正式 EP01_008 宫格 03–06 的 P01 连续性引用必须落入语义资产、唯一槽位与当前硬锁 SHA", async () => {
  const sidecar = getSidecarPaths(FORMAL_PROJECT_ROOT);
  const [selections, store] = await Promise.all([
    readJson<FusionStoryboardGridSelectionStore>(sidecar.storyboardGridSelections, {
      schemaVersion: 1,
      revision: 0,
      items: {},
      updatedAt: new Date(0).toISOString(),
    }),
    loadFusionPanelReferenceStore(FORMAL_PROJECT_ROOT),
  ]);
  expect(store).not.toBeNull();
  const unitItemId = "season-三-ep01-unit008";
  const selection = selections.items[unitItemId];
  expect(selection).toBeDefined();
  const contract = await readJson<FusionStoryboardGridContract | null>(
    path.join(sidecar.storyboardGrids, unitItemId, `${selection!.contractId}.json`),
    null,
  );
  expect(contract).not.toBeNull();
  const continuityPanels = contract!.panels.filter((panel) => panel.index >= 3 && panel.index <= 6);
  expect(continuityPanels.map((panel) => panel.index)).toEqual([3, 4, 5, 6]);

  const hardLockPaths = new Set<string>();
  for (const panel of continuityPanels) {
    expect(panel.continuityReferenceAssetIds).toContain("P01");
    const resolution = store!.resolutions[`${contract!.contractId}:${panel.id}`];
    expect(resolution, `缺少 panel-${panel.index} resolution`).toBeDefined();
    const semantic = resolution!.semanticAssets.find((asset) => asset.assetId === "P01");
    expect(semantic, `panel-${panel.index} 的 P01 未进入 semanticAssets`).toBeDefined();
    expect(semantic?.hardLock).toMatchObject({
      assetId: "P01",
      authority: "reviewed-hard-lock",
      sha256: FORMAL_P01_HARD_LOCK_SHA256,
    });
    hardLockPaths.add(semantic!.hardLock!.path);
    const slots = resolution!.referenceSlots.filter((slot) => slot.kind === "canonical-asset" && slot.assetId === "P01");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      coveredAssetIds: ["P01"],
      readiness: "ready",
      path: semantic!.hardLock!.path,
      sha256: FORMAL_P01_HARD_LOCK_SHA256,
    });
  }
  expect(hardLockPaths.size).toBe(1);
  const [hardLockPath] = [...hardLockPaths];
  const hardLockBytes = await readFile(hardLockPath!);
  expect(createHash("sha256").update(hardLockBytes).digest("hex")).toBe(FORMAL_P01_HARD_LOCK_SHA256);
}, 30_000);
